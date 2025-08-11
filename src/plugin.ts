import { Plugin, Notice, PluginSettingTab, App, Setting, EventRef, MarkdownView, Editor, TFile, Modal } from "obsidian";
import { MermaidZoomPluginSettings, DEFAULT_SETTINGS, MermaidBlock } from "./types";
import { validateMermaidAsync, extractMermaidBlocks, hasMermaid, clamp } from "./utils";
import { geminiFixWithBackoff, preserveInitIfNeeded } from "./gemini";
import { FixPreviewModal } from "./modal";
import { applyReplacementsReverse } from "./replacements";

export default class MermaidZoomPlugin extends Plugin {
  private currentModal: HTMLElement | null = null;
  settings: MermaidZoomPluginSettings;
  private fileOpenRef: EventRef | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    await this.injectCss();
    this.addSettingTab(new MermaidZoomSettingTab(this.app, this));

    this.registerDomEvent(document, "click", (event) => {
      const target = event.target as HTMLElement;
      if (target?.closest?.(".mermaid-zoom-modal")) return;
      const mermaidElement = target?.closest?.(".mermaid") as HTMLElement | null;
      if (mermaidElement) {
        this.showPopup(mermaidElement, this.findMermaidSource(mermaidElement));
      }
    });

    // コマンドを追加
    this.addCommand({
      id: "mermaid-validate",
      name: "Mermaid: 構文エラー検出",
      icon: "search",
      callback: async () => { await this.runValidateOnly(); },
    });
    this.addCommand({
      id: "mermaid-fix-gemini",
      name: "Mermaid: 構文エラーをGeminiで修正",
      icon: "sparkles",
      callback: async () => { await this.runFixWithGemini(); },
    });
    this.addCommand({
      id: "mermaid-validate-all",
      name: "Mermaid: 全ファイルの構文エラー検出",
      icon: "search",
      callback: async () => { await this.runValidateAllFiles(); },
    });
    this.addCommand({
      id: "mermaid-fix-gemini-all",
      name: "Mermaid: 全ファイルの構文エラーをGeminiで修正",
      icon: "sparkles",
      callback: async () => { await this.runFixAllFilesWithGemini(); },
    });

    // リボンアイコンを追加
    this.addRibbonIcon("search", "Mermaid: 構文エラー検出", async () => {
      await this.runValidateOnly();
    });

    this.addRibbonIcon("sparkles", "Mermaid: 構文エラーをGeminiで修正", async () => {
      await this.runFixWithGemini();
    });
  }

  onunload() {
    if (this.fileOpenRef) {
      this.app.workspace.offref(this.fileOpenRef);
      this.fileOpenRef = null;
    }
  }

  private async injectCss() {
    const styleId = "mermaid-zoom-plugin-styles";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    try {
      const path = (this as any).manifest?.dir ? `${(this as any).manifest.dir}/styles.css` : "";
      const maybe = path ? await this.app.vault.adapter.read?.(path) : "";
      if (maybe && typeof maybe === "string") {
        style.textContent = maybe;
      }
    } catch (e) {
      console.debug("Mermaid Zoom Plugin: styles.css の読み込みをスキップ:", e);
    }
    document.head.appendChild(style);
  }

  private findMermaidSource(mermaidEl: HTMLElement): HTMLElement | null {
    let prev: Element | null = mermaidEl.previousElementSibling;
    const query = () => prev?.querySelector?.("code.language-mermaid") as HTMLElement | null;
    let found = query();
    if (found) return found;
    prev = mermaidEl.parentElement?.previousElementSibling ?? null;
    found = prev?.querySelector?.("code.language-mermaid") as HTMLElement | null;
    return found ?? null;
  }

  private async showPopup(element: HTMLElement, sourceCodeEl: HTMLElement | null) {
    if (this.currentModal) this.currentModal.remove();

    const fixBackdrop = document.querySelector('.mermaid-fix-backdrop') as HTMLElement | null;
    const fixModal = document.querySelector('.mermaid-fix-modal') as HTMLElement | null;
    const retreatOnce = async () => {
      const targets = [fixBackdrop, fixModal].filter(Boolean) as HTMLElement[];
      if (targets.length === 0) return;
      const wait = (el: HTMLElement) => new Promise<void>((resolve) => {
        let done = false;
        const cleanup = () => { if (done) return; done = true; el.removeEventListener('transitionend', onEnd); resolve(); };
        const onEnd = (ev: Event) => { if (ev.target === el) cleanup(); };
        el.addEventListener('transitionend', onEnd);
        setTimeout(cleanup, 250);
      });
      targets.forEach(el => el.classList.add('mermaid-fix-retreating'));
      await Promise.all(targets.map(wait));
    };
    await retreatOnce();

    let zoomLevel = 1, isPanning = false, panX = 0, panY = 0, lastMouseX = 0, lastMouseY = 0;
    const modal = this.createElement("div", "mermaid-zoom-modal");
    const content = this.createElement("div", "mermaid-zoom-content");
    const clonedElement = element.cloneNode(true) as HTMLElement;
    clonedElement.className = "mermaid-zoom-clone";
    const themeClass = document.body.classList.contains("theme-dark") ? "theme-dark" : "theme-light";
    clonedElement.classList.add(themeClass);
    clonedElement.querySelector("svg")?.classList.add(themeClass);

    // 配置と原点を左上に固定し、ズレを防止
    (content as HTMLElement).style.position = "relative";
    Object.assign(clonedElement.style, {
      position: "absolute",
      top: "0",
      left: "0",
      transformOrigin: "0 0",
    } as Partial<CSSStyleDeclaration>);

    const closeModal = () => {
      modal.remove();
      document.removeEventListener("keydown", handleKeyDown);
      if (this.fileOpenRef) this.app.workspace.offref(this.fileOpenRef);
      this.currentModal = null;
      document.body.classList.remove("mermaid-zoom-active");
      // 退避クラスを解除して修正モーダルの操作を復帰
      try {
        fixBackdrop?.classList.remove('mermaid-fix-retreating');
        fixModal?.classList.remove('mermaid-fix-retreating');
      } catch {}
    };

    const toolbar = this.createToolbar(closeModal, () => this.copyAsSvg(element), () => this.copyAsPng(element));
    const { zoomInButton, zoomOutButton, zoomDisplay, resetZoomButton } = this.createZoomControls(
      () => zoomLevel,
      (newZoom, newPanX = 0, newPanY = 0) => {
        zoomLevel = newZoom;
        panX = newPanX;
        panY = newPanY;
        updateTransform();
      }
    );
    toolbar.append(zoomOutButton, zoomDisplay, zoomInButton, resetZoomButton);
    content.appendChild(clonedElement);
    modal.append(toolbar, content);

    document.body.classList.add("mermaid-zoom-active");
    document.body.appendChild(modal);
    this.currentModal = modal;

    this.fileOpenRef = this.app.workspace.on("file-open", () => closeModal());
    const handleKeyDown = (e: KeyboardEvent) => e.key === "Escape" && closeModal();
    document.addEventListener("keydown", handleKeyDown);
    modal.addEventListener("click", (e) => e.target === modal && closeModal());

    content.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement)?.closest("a.internal-link, .internal-link, a[data-href], [data-href]");
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const getHref = (el: Element): string | null => el.getAttribute("data-href") || el.getAttribute("href") || (el as any).href?.baseVal || el.getAttribute("xlink:href");
      const target = getHref(link);
      if (!target) return;
      const fromPath = this.app.workspace.getActiveFile()?.path ?? "";
      const newLeaf = (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey;
      this.app.workspace.openLinkText(target, fromPath, newLeaf);
      closeModal();
    });

    const updateTransform = () => {
      clonedElement.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
      zoomDisplay.textContent = `${Math.round(zoomLevel * 100)}%`;
    };

    content.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement)?.closest('a')) return; isPanning = true; content.classList.add('grabbing'); lastMouseX = e.pageX; lastMouseY = e.pageY; });
    content.addEventListener('mouseup', () => { isPanning = false; content.classList.remove('grabbing'); });
    content.addEventListener('mouseleave', () => { isPanning = false; content.classList.remove('grabbing'); });
    content.addEventListener('mousemove', (e) => { if (!isPanning) return; e.preventDefault(); panX += e.pageX - lastMouseX; panY += e.pageY - lastMouseY; lastMouseX = e.pageX; lastMouseY = e.pageY; updateTransform(); });
    content.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = content.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const old = zoomLevel;
      const zoomFactor = e.deltaY < 0 ? 1.2 : 1 / 1.2; // 乗算型ズーム
      const next = clamp(old * zoomFactor, 0.1, 10);

      // ズーム前ローカル座標（逆変換）を保持
      const localX = (mouseX - panX) / old;
      const localY = (mouseY - panY) / old;

      // 同一点がカーソル下に来るようpanを再計算
      panX = mouseX - localX * next;
      panY = mouseY - localY * next;
      zoomLevel = next;
      updateTransform();
    }, { passive: false });

    requestAnimationFrame(() => {
      const contentRect = content.getBoundingClientRect();
      const cloneRect = clonedElement.getBoundingClientRect();
      zoomLevel = Math.min(
        contentRect.width / cloneRect.width,
        contentRect.height / cloneRect.height
      ) * 0.95;
      // 中央寄せして初期表示を安定させる
      panX = (contentRect.width - cloneRect.width * zoomLevel) / 2;
      panY = (contentRect.height - cloneRect.height * zoomLevel) / 2;
      updateTransform();
    });
  }

  private createElement<K extends keyof HTMLElementTagNameMap>(tagName: K, className: string): HTMLElementTagNameMap[K] { const el = document.createElement(tagName); el.className = className; return el; }
  private createToolbar(onClose: () => void, onCopySvg: () => void, onCopyPng: () => void): HTMLElement {
    const toolbar = this.createElement("div", "mermaid-zoom-toolbar");
    const closeButton = this.createButton("✖", "閉じる", onClose);
    const copySvgButton = this.createButton("SVG", "SVGをコピー", onCopySvg);
    const copyPngButton = this.createButton("PNG", "PNGをコピー", onCopyPng);
    toolbar.append(copySvgButton, copyPngButton, closeButton);
    return toolbar;
  }
  private createZoomControls(getZoom: () => number, onZoom: (zoom: number, panX?: number, panY?: number) => void) {
    const zoomOutButton = this.createButton("－", "縮小", () => onZoom(clamp(getZoom() - 0.2, 0.1, 10)));
    const zoomInButton = this.createButton("＋", "拡大", () => onZoom(clamp(getZoom() + 0.2, 0.1, 10)));
    const resetZoomButton = this.createButton("1:1", "リセット", () => onZoom(1.0, 0, 0));
    const zoomDisplay = this.createElement("span", "zoom-display");
    zoomDisplay.textContent = "100%";
    return { zoomInButton, zoomOutButton, zoomDisplay, resetZoomButton };
  }
  private createButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = this.createElement("button", "");
    button.textContent = text;
    button.title = title;
    button.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return button;
  }

  private async runValidateOnly() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice("アクティブなMarkdownノートが見つかりません。"); return; }
    if (!hasMermaid()) { new Notice("Mermaid がロードされていません。"); return; }

    const text = view.editor.getValue();
    const blocks = extractMermaidBlocks(text);
    if (blocks.length === 0) { new Notice("Mermaid コードブロックは見つかりませんでした。"); return; }

    const errors: { idx: number; msg: string }[] = [];
    for (const b of blocks) {
      const r = await validateMermaidAsync(b.code);
      if (!r.ok) errors.push({ idx: b.index, msg: r.error ?? "構文エラー" });
    }

    if (errors.length === 0) {
      new Notice(`検出完了: ${blocks.length}件中エラーなし。`);
    } else {
      new Notice(`検出完了: エラー ${errors.length}件。詳細は開発者コンソールを確認してください。`, 6000);
      console.group("Mermaid 構文エラー");
      errors.forEach(e => console.log(`ブロック #${e.idx + 1}:`, e.msg));
      console.groupEnd();
    }
  }

  private async runFixWithGemini() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice("アクティブなMarkdownノートが見つかりません。"); return; }
    if (!this.settings.geminiApiKey) { new Notice("Gemini APIキーが未設定です。設定画面から登録してください。", 6000); return; }
    if (!hasMermaid()) { new Notice("Mermaidライブラリがロードされていないため、構文を検証できません。"); return; }

    const editor = view.editor;
    const allBlocks = extractMermaidBlocks(editor.getValue());
    if (allBlocks.length === 0) { new Notice("Mermaidコードブロックは見つかりませんでした。"); return; }

    new Notice(`全${allBlocks.length}件のMermaidブロックを検査しています...`);

    const errorBlocks: { block: MermaidBlock; error: string }[] = [];
    for (const block of allBlocks) {
      const validation = await validateMermaidAsync(block.code);
      if (!validation.ok) {
        errorBlocks.push({ block, error: validation.error ?? "不明な構文エラー" });
      }
    }

    if (errorBlocks.length === 0) { new Notice("検査完了: エラーのあるMermaidブロックは見つかりませんでした。"); return; }

    new Notice(`エラーが${errorBlocks.length}件見つかりました。Geminiで修正を開始します。`);

    const replacements: { start: number; end: number; text: string }[] = [];
    let autoApply = this.settings.applyMode === "auto";
    let cancelled = false;

    const currentFile: TFile | null = this.app.workspace.getActiveFile();
    const stopIfFileChanged = () => {
      const now = this.app.workspace.getActiveFile();
      if ((currentFile?.path ?? "") !== (now?.path ?? "")) {
        cancelled = true;
        return true;
      }
      return false;
    };

    for (const { block, error: initialError } of errorBlocks) {
      if (cancelled || stopIfFileChanged()) { new Notice("処理を中断しました（ファイル変更）。"); break; }

      let currentCode = block.code, lastError = initialError, fixedCode: string | null = null, success = false;
      const maxAttempts = 5;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        new Notice(`#${block.index + 1}: 修正を試行中... (${attempt}/${maxAttempts})`);
        try {
          const proposedFix = await geminiFixWithBackoff(this.settings.geminiApiKey!, this.settings.geminiModel, currentCode, lastError, this.settings.requestTimeoutMs);
          const codeToValidate = preserveInitIfNeeded(block.code, proposedFix, this.settings.preserveInitDirective);

          const validation = await validateMermaidAsync(codeToValidate);
          if (validation.ok) {
            new Notice(`#${block.index + 1}: 修正案の検証に成功しました。`);
            fixedCode = codeToValidate;
            success = true;
            break;
          } else {
            lastError = validation.error ?? "修正後もエラーが残っています";
            currentCode = codeToValidate;
            if (attempt < maxAttempts) new Notice(`#${block.index + 1}: 修正案にエラーあり。再試行します。`);
          }
        } catch (e: any) {
          console.error(`Gemini修正失敗 #${block.index + 1} (試行 ${attempt}):`, e);
          new Notice(`Gemini修正エラー #${block.index + 1}: ${e.message}`, 6000);
          success = false;
          if (/認証エラー|モデルが見つかりません|応答のJSON解析/i.test(String(e?.message ?? e))) {
            cancelled = true;
          }
          break;
        }
      }

      if (cancelled) break;

      if (success && fixedCode) {
        if (autoApply) {
          replacements.push({ start: block.startOffset, end: block.endOffset, text: fixedCode });
          new Notice(`#${block.index + 1}: 修正を自動適用キューに追加しました。`);
        } else {
          await new Promise<void>((resolve) => {
            const modal = new FixPreviewModal({
              original: block.code,
              proposed: fixedCode!,
              onReplace: () => {
                replacements.push({ start: block.startOffset, end: block.endOffset, text: fixedCode! });
                resolve();
              },
              onSkip: () => { resolve(); },
              onAutoApply: async () => {
                autoApply = true;
                this.settings.applyMode = "auto";
                await this.saveData(this.settings);
                replacements.push({ start: block.startOffset, end: block.endOffset, text: fixedCode! });
                resolve();
              },
            });
            modal.open();
          });
        }
      } else {
        new Notice(`#${block.index + 1}: 自動修正に失敗しました（最大試行 ${maxAttempts} 回）。`, 6000);
      }
    }

    if (!cancelled && replacements.length > 0) {
      applyReplacementsReverse(editor, replacements);
      new Notice(`Mermaidの修正を${replacements.length}件適用しました。`);
    } else if (!cancelled) {
      new Notice("適用された修正はありませんでした。");
    }
  }

  private async runValidateAllFiles() {
    if (!hasMermaid()) { new Notice("Mermaidライブラリがロードされていないため、構文を検証できません。"); return; }

    const markdownFiles = this.app.vault.getMarkdownFiles();
    if (markdownFiles.length === 0) { new Notice("Markdownファイルが見つかりません。"); return; }

    // 確認ダイアログ
    const confirmed = await this.showConfirmDialog(
      "全ファイル検証の確認",
      `全${markdownFiles.length}ファイルのMermaidブロックを検査しますか？\n\nこの処理には時間がかかる場合があります。`
    );
    
    if (!confirmed) return;

    new Notice(`全${markdownFiles.length}ファイルのMermaidブロックを検査しています...`);

    let totalBlocks = 0;
    let totalErrors = 0;
    const errorFiles: { file: TFile; errors: { block: MermaidBlock; error: string }[] }[] = [];

    for (const file of markdownFiles) {
      try {
        const content = await this.app.vault.read(file);
        const allBlocks = extractMermaidBlocks(content);
        totalBlocks += allBlocks.length;

        if (allBlocks.length > 0) {
          const fileErrors: { block: MermaidBlock; error: string }[] = [];
          for (const block of allBlocks) {
            const validation = await validateMermaidAsync(block.code);
            if (!validation.ok) {
              fileErrors.push({ block, error: validation.error ?? "不明な構文エラー" });
            }
          }
          if (fileErrors.length > 0) {
            errorFiles.push({ file, errors: fileErrors });
            totalErrors += fileErrors.length;
          }
        }
      } catch (error) {
        console.error(`ファイル読み込みエラー: ${file.path}`, error);
      }
    }

    if (totalErrors === 0) {
      new Notice(`検査完了: 全${totalBlocks}件のMermaidブロックでエラーは見つかりませんでした。`);
    } else {
      const errorMessage = `検査完了: ${totalErrors}件のエラーが${errorFiles.length}ファイルで見つかりました。`;
      console.log("Mermaid構文エラー詳細:", errorFiles);
      new Notice(errorMessage);
    }
  }

  private async runFixAllFilesWithGemini() {
    if (!this.settings.geminiApiKey) { new Notice("Gemini APIキーが未設定です。設定画面から登録してください。", 6000); return; }
    if (!hasMermaid()) { new Notice("Mermaidライブラリがロードされていないため、構文を検証できません。"); return; }

    const markdownFiles = this.app.vault.getMarkdownFiles();
    if (markdownFiles.length === 0) { new Notice("Markdownファイルが見つかりません。"); return; }

    // 確認ダイアログ
    const confirmed = await this.showConfirmDialog(
      "全ファイル修正の確認",
      `全${markdownFiles.length}ファイルのMermaidブロックを検査・修正しますか？\n\n⚠️ この処理により複数のファイルが変更される可能性があります。\nこの処理には時間がかかる場合があります。`
    );
    
    if (!confirmed) return;

    new Notice(`全${markdownFiles.length}ファイルのMermaidブロックを検査・修正しています...`);

    let totalFixed = 0;
    let totalErrors = 0;
    let cancelled = false;

    for (const file of markdownFiles) {
      if (cancelled) break;

      try {
        const content = await this.app.vault.read(file);
        const allBlocks = extractMermaidBlocks(content);
        
        if (allBlocks.length === 0) continue;

        const errorBlocks: { block: MermaidBlock; error: string }[] = [];
        for (const block of allBlocks) {
          const validation = await validateMermaidAsync(block.code);
          if (!validation.ok) {
            errorBlocks.push({ block, error: validation.error ?? "不明な構文エラー" });
          }
        }

        if (errorBlocks.length === 0) continue;

        totalErrors += errorBlocks.length;
        new Notice(`${file.basename}: ${errorBlocks.length}件のエラーを修正中...`);

        const replacements: { start: number; end: number; text: string }[] = [];
        let autoApply = this.settings.applyMode === "auto";

        for (const { block, error: initialError } of errorBlocks) {
          if (cancelled) break;

          let currentCode = block.code, lastError = initialError, fixedCode: string | null = null, success = false;
          const maxAttempts = 3; // 全ファイル処理のため試行回数を減らす

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const proposedFix = await geminiFixWithBackoff(this.settings.geminiApiKey!, this.settings.geminiModel, currentCode, lastError, this.settings.requestTimeoutMs);
              const codeToValidate = preserveInitIfNeeded(block.code, proposedFix, this.settings.preserveInitDirective);

              const validation = await validateMermaidAsync(codeToValidate);
              if (validation.ok) {
                fixedCode = codeToValidate;
                success = true;
                break;
              } else {
                lastError = validation.error ?? "修正後もエラーが残っています";
                currentCode = codeToValidate;
              }
            } catch (e: any) {
              console.error(`Gemini修正失敗 ${file.basename} #${block.index + 1}:`, e);
              if (/認証エラー|モデルが見つかりません|応答のJSON解析/i.test(String(e?.message ?? e))) {
                cancelled = true;
              }
              break;
            }
          }

          if (success && fixedCode) {
            if (autoApply) {
              replacements.push({ start: block.startOffset, end: block.endOffset, text: fixedCode });
            } else {
              // 通常の修正と同じ方法でユーザーに確認
              await new Promise<void>((resolve) => {
                const modal = new FixPreviewModal({
                  original: block.code,
                  proposed: fixedCode!,
                  onReplace: () => {
                    replacements.push({ start: block.startOffset, end: block.endOffset, text: fixedCode! });
                    resolve();
                  },
                  onSkip: () => { resolve(); },
                  onAutoApply: async () => {
                    autoApply = true;
                    this.settings.applyMode = "auto";
                    await this.saveData(this.settings);
                    replacements.push({ start: block.startOffset, end: block.endOffset, text: fixedCode! });
                    resolve();
                  },
                });
                modal.open();
              });
            }
          } else {
            new Notice(`${file.basename} #${block.index + 1}: 自動修正に失敗しました（最大試行 ${maxAttempts} 回）。`, 6000);
          }
        }

        if (replacements.length > 0) {
          // ファイルを更新
          const newContent = this.applyReplacementsToContent(content, replacements);
          await this.app.vault.modify(file, newContent);
          totalFixed += replacements.length;
        }

      } catch (error) {
        console.error(`ファイル処理エラー: ${file.path}`, error);
      }
    }

    if (cancelled) {
      new Notice("全ファイル処理を中断しました。");
    } else {
      new Notice(`全ファイル処理完了: ${totalFixed}件の修正を適用しました。`);
    }
  }

  private applyReplacementsToContent(content: string, replacements: { start: number; end: number; text: string }[]): string {
    // 置換を逆順で適用（インデックスがずれないように）
    const sortedReplacements = [...replacements].sort((a, b) => b.start - a.start);
    let result = content;
    
    for (const replacement of sortedReplacements) {
      result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
    }
    
    return result;
  }

  private async showConfirmDialog(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText(title);
      modal.contentEl.innerHTML = `
        <div style="padding: 20px;">
          <p style="margin-bottom: 20px; white-space: pre-line;">${message}</p>
          <div style="display: flex; gap: 10px; justify-content: flex-end;">
            <button class="mod-warning" id="confirm-cancel">キャンセル</button>
            <button class="mod-cta" id="confirm-ok">実行</button>
          </div>
        </div>
      `;

      const cancelBtn = modal.contentEl.querySelector('#confirm-cancel');
      const okBtn = modal.contentEl.querySelector('#confirm-ok');

      cancelBtn?.addEventListener('click', () => {
        modal.close();
        resolve(false);
      });

      okBtn?.addEventListener('click', () => {
        modal.close();
        resolve(true);
      });

      modal.open();
    });
  }



  private cloneSvgWithInlineStyles(orig: SVGSVGElement): SVGSVGElement {
    const clone = orig.cloneNode(true) as SVGSVGElement;
    const traverse = (src: Element, dst: Element) => {
      const comp = getComputedStyle(src);
      const props = ["stroke", "stroke-width", "opacity", "color", "font", "font-family", "font-size"] as const;
      const origFillAttr = src.getAttribute("fill");
      const compFill = comp.getPropertyValue("fill");
      if (origFillAttr?.trim() === "none") {
        (dst as HTMLElement).setAttribute("fill", "none");
      } else if (compFill && compFill !== "rgba(0, 0, 0, 0)") {
        (dst as HTMLElement).style.setProperty("fill", compFill);
      }
      props.forEach(p => {
        const v = comp.getPropertyValue(p);
        if (v && v !== "none" && v !== "rgba(0, 0, 0, 0)") (dst as HTMLElement).style.setProperty(p, v);
      });
      Array.from(src.children).forEach((c, i) => traverse(c, (dst.children[i] as Element)));
    };
    traverse(orig, clone);
    return clone;
  }

  private replaceHtmlLabels(svg: SVGSVGElement) {
    svg.querySelectorAll("foreignObject").forEach(fo => {
      const span = fo.querySelector("span, div");
      const label = span?.textContent?.trim();
      if (!label) return;
      const x = parseFloat(fo.getAttribute("x") ?? "0"), y = parseFloat(fo.getAttribute("y") ?? "0");
      const w = parseFloat(fo.getAttribute("width") ?? "0"), h = parseFloat(fo.getAttribute("height") ?? "0");
      const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textEl.setAttribute("x", (x + w / 2).toString());
      textEl.setAttribute("y", (y + h / 2).toString());
      textEl.setAttribute("text-anchor", "middle");
      textEl.setAttribute("dominant-baseline", "central");
      textEl.setAttribute("alignment-baseline", "central");
      const comp = getComputedStyle(span as Element);
      ["font-family", "font-size", "font-weight", "fill", "color"].forEach(p => {
        textEl.style.setProperty(p, comp.getPropertyValue(p));
      });
      textEl.textContent = label;
      fo.parentNode?.replaceChild(textEl, fo);
    });
  }

  private async copyAsSvg(originalContainerEl: HTMLElement) {
    const srcSvg = originalContainerEl.querySelector("svg");
    if (!srcSvg) { new Notice("SVG要素が見つかりませんでした。"); return; }
    const svgClone = this.cloneSvgWithInlineStyles(srcSvg as SVGSVGElement);
    this.replaceHtmlLabels(svgClone);
    svgClone.removeAttribute("class");
    if (!svgClone.hasAttribute("viewBox")) {
      const { width, height } = (srcSvg as SVGSVGElement).getBBox();
      svgClone.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
    if (!svgClone.hasAttribute("width") || !svgClone.hasAttribute("height")) {
      const rect = (srcSvg as SVGSVGElement).getBoundingClientRect();
      svgClone.setAttribute("width", rect.width.toString());
      svgClone.setAttribute("height", rect.height.toString());
    }
    await navigator.clipboard.writeText(new XMLSerializer().serializeToString(svgClone));
    new Notice("SVGデータをクリップボードにコピーしました。");
  }

  private async copyAsPng(originalContainerEl: HTMLElement) {
    const srcSvg = originalContainerEl.querySelector("svg");
    if (!srcSvg) { new Notice("SVG要素が見つかりませんでした。"); return; }

    new Notice("PNGに変換中…");
    try {
      const svgClone = this.cloneSvgWithInlineStyles(srcSvg as SVGSVGElement);
      this.replaceHtmlLabels(svgClone);
      const { width, height } = (srcSvg as SVGSVGElement).getBoundingClientRect();
      const scale = this.settings.pngScale ?? 2;
      svgClone.setAttribute("width", `${width * scale}`);
      svgClone.setAttribute("height", `${height * scale}`);
      const svgData = new XMLSerializer().serializeToString(svgClone);

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvasコンテキストの取得に失敗しました。");

      const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgData)))}`;
      const img = new Image();
      img.onload = async () => {
        try {
          ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("background-color") || "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          await new Promise<void>((resolve, reject) => {
            canvas.toBlob(async (blob) => {
              if (!blob) { reject(new Error("PNG Blobの生成に失敗しました。")); return; }
              try {
                if (typeof (window as any).ClipboardItem === "function") {
                  await navigator.clipboard.write([new (window as any).ClipboardItem({ "image/png": blob })]);
                  new Notice("PNG画像をクリップボードにコピーしました。");
                } else {
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "diagram.png";
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                  new Notice("PNGをファイルとして保存しました（ClipboardItem非対応のため）。");
                }
                resolve();
              } catch (err) { reject(err); }
            }, "image/png");
          });
        } catch (err: any) {
          throw err;
        }
      };
      img.onerror = () => { throw new Error("PNGへの変換に失敗しました（画像読み込みエラー）。"); };
      img.src = dataUrl;
    } catch (error: any) {
      console.error("PNG copy failed:", error);
      new Notice(`PNGのコピーに失敗しました: ${error.message ?? String(error)}`);
    }
  }
}

class MermaidZoomSettingTab extends PluginSettingTab {
  plugin: MermaidZoomPlugin;
  constructor(app: App, plugin: MermaidZoomPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Mermaid Zoom Plugin 設定" });

    new Setting(containerEl)
      .setName("PNG解像度スケール")
      .setDesc("PNGエクスポート時の解像度倍率（例: 2 で2倍）")
      .addText(text => text.setPlaceholder("2").setValue(this.plugin.settings.pngScale.toString())
        .onChange(async (value) => {
          const num = Number(value);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.pngScale = num;
            await this.plugin.saveData(this.plugin.settings);
          }
        }));

    containerEl.createEl("h3", { text: "Gemini 連携" });
    new Setting(containerEl)
      .setName("Gemini API Key")
      .setDesc("Google AI Studio で取得したAPIキー。ローカルにのみ保存されます。")
      .addText((t) => t.setPlaceholder("AIza…").setValue(this.plugin.settings.geminiApiKey ?? "")
        .onChange(async (v) => {
          this.plugin.settings.geminiApiKey = v.trim();
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("Model")
      .setDesc("使用するモデル名。例: gemini-1.5-flash-latest / gemini-2.0-flash-exp など")
      .addText((t) => t.setValue(this.plugin.settings.geminiModel)
        .onChange(async (v) => {
          this.plugin.settings.geminiModel = v.trim() || "gemini-1.5-flash-latest";
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("適用モード")
      .setDesc("修正を適用する際の既定の動作を選択します。")
      .addDropdown((d) => d.addOption("confirm", "毎回確認する").addOption("auto", "自動的に適用する")
        .setValue(this.plugin.settings.applyMode)
        .onChange(async (v) => {
          this.plugin.settings.applyMode = v as "confirm" | "auto";
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName("リクエストタイムアウト (ms)")
      .setDesc("Gemini APIからの応答を待つ最大時間（ミリ秒）。AbortControllerで中断します。")
      .addText((t) => t.setPlaceholder("30000").setValue(String(this.plugin.settings.requestTimeoutMs))
        .onChange(async (v) => {
          const n = Number(v);
          if (!Number.isNaN(n) && n > 0) {
            this.plugin.settings.requestTimeoutMs = n;
            await this.plugin.saveData(this.plugin.settings);
          }
        }));

    new Setting(containerEl)
      .setName("%%{init}%% ディレクティブを保持")
      .setDesc("修正時に、元のコードに含まれるテーマ指定などの `init` ディレクティブを維持します。")
      .addToggle((tog) => tog.setValue(this.plugin.settings.preserveInitDirective)
        .onChange(async (val) => {
          this.plugin.settings.preserveInitDirective = val;
          await this.plugin.saveData(this.plugin.settings);
        }));
  }
}
