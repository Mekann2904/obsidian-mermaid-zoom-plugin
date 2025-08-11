// 独自モーダル（修正プレビュー）
import { DiffLine, calculateDiff } from "./utils";

export class FixPreviewModal {
  private modal: HTMLElement | null = null;
  private backdrop: HTMLElement | null = null;
  private opts: { original: string; proposed: string; onReplace: () => void; onSkip: () => void; onAutoApply: () => void; };
  private currentMode: 'side-by-side' | 'inline' = 'side-by-side';
  private panelsContainer: HTMLElement | null = null;
  private leftPanel: HTMLElement | null = null;
  private rightPanel: HTMLElement | null = null;
  private renderPanel: HTMLElement | null = null;

  constructor(opts: { original: string; proposed: string; onReplace: () => void; onSkip: () => void; onAutoApply: () => void; }) {
    this.opts = opts;
  }

  open(): void {
    this.createModal();
    this.renderContent();
    this.attachEventListeners();
    this.backdrop!.appendChild(this.modal!);
    document.body.appendChild(this.backdrop!);
    setTimeout(() => {
      this.backdrop!.classList.add("mermaid-fix-backdrop-visible");
      this.modal!.classList.add("mermaid-fix-modal-visible");
    }, 10);
  }

  close(): void {
    if (!this.modal || !this.backdrop) return;
    this.backdrop.classList.remove("mermaid-fix-backdrop-visible");
    this.modal.classList.remove("mermaid-fix-modal-visible");
    setTimeout(() => {
      this.modal?.remove();
      this.backdrop?.remove();
      this.modal = null;
      this.backdrop = null;
    }, 200);
  }

  private createModal(): void {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "mermaid-fix-backdrop";
    this.modal = document.createElement("div");
    this.modal.className = "mermaid-fix-modal";
  }

  private renderContent(): void {
    if (!this.modal) return;

    const header = document.createElement("div");
    header.className = "mermaid-fix-header";
    const title = document.createElement("h3");
    title.textContent = "Mermaid 修正プレビュー";
    title.className = "mermaid-fix-title";
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.className = "mermaid-fix-close-btn";
    closeBtn.onclick = () => this.close();
    header.appendChild(closeBtn);

    const content = document.createElement("div");
    content.className = "mermaid-fix-content";

    // 差分表示モード切り替えボタン
    const diffModeToggle = document.createElement("div");
    diffModeToggle.className = "mermaid-fix-mode-toggle";
    const sideBySideBtn = document.createElement("button");
    sideBySideBtn.textContent = "左右比較";
    sideBySideBtn.className = "mermaid-fix-mode-btn active";
    sideBySideBtn.onclick = () => this.switchToSideBySideMode();
    const inlineBtn = document.createElement("button");
    inlineBtn.textContent = "行内差分";
    inlineBtn.className = "mermaid-fix-mode-btn";
    inlineBtn.onclick = () => this.switchToInlineMode();
    diffModeToggle.appendChild(sideBySideBtn);
    diffModeToggle.appendChild(inlineBtn);

    const controls = document.createElement("div");
    controls.className = "mermaid-fix-controls";
    controls.appendChild(diffModeToggle);

    // エラー表示エリア
    const errorDisplay = document.createElement("div");
    errorDisplay.className = "mermaid-fix-error";
    errorDisplay.style.display = "none";
    controls.appendChild(errorDisplay);

    // Side-by-Side モード（デフォルト）
    this.leftPanel = document.createElement("div");
    this.leftPanel.className = "mermaid-fix-panel";
    const originalLabel = document.createElement("div");
    originalLabel.textContent = "元のコード";
    originalLabel.className = "mermaid-fix-label";
    const originalCode = document.createElement("pre");
    originalCode.textContent = this.opts.original;
    originalCode.className = "mermaid-fix-code";
    this.leftPanel.appendChild(originalLabel);
    this.leftPanel.appendChild(originalCode);

    this.rightPanel = document.createElement("div");
    this.rightPanel.className = "mermaid-fix-panel";
    const proposedLabel = document.createElement("div");
    proposedLabel.textContent = "修正後のコード";
    proposedLabel.className = "mermaid-fix-label";
    const proposedCode = document.createElement("pre");
    proposedCode.textContent = this.opts.proposed;
    proposedCode.className = "mermaid-fix-code";
    proposedCode.contentEditable = "true";
    proposedCode.oninput = () => this.onCodeEdit(proposedCode.textContent || "");
    this.rightPanel.appendChild(proposedLabel);
    this.rightPanel.appendChild(proposedCode);

    this.renderPanel = document.createElement("div");
    this.renderPanel.className = "mermaid-fix-panel";
    const renderLabel = document.createElement("div");
    renderLabel.textContent = "修正後のレンダリング（クリックで拡大）";
    renderLabel.className = "mermaid-fix-label";
    const renderContainer = document.createElement("div");
    renderContainer.className = "mermaid-fix-render";
    renderContainer.innerHTML = '<div class="mermaid-fix-loading">レンダリング中...</div>';
    this.renderPanel.appendChild(renderLabel);
    this.renderPanel.appendChild(renderContainer);

    this.panelsContainer = document.createElement("div");
    this.panelsContainer.className = "mermaid-fix-panels";
    this.panelsContainer.appendChild(this.leftPanel);
    this.panelsContainer.appendChild(this.rightPanel);
    this.panelsContainer.appendChild(this.renderPanel);

    content.appendChild(controls);
    content.appendChild(this.panelsContainer);

    // 初期レンダリング
    this.renderMermaid(renderContainer, this.opts.proposed, "修正後のコード");
    
    // 同期スクロール設定
    this.setupSyncScroll(originalCode, proposedCode);

    const footer = document.createElement("div");
    footer.className = "mermaid-fix-footer";

    const createButton = (text: string, onClick: () => void, primary = false) => {
      const btn = document.createElement("button");
      btn.textContent = text;
      btn.className = primary ? "mermaid-fix-btn mermaid-fix-btn-primary" : "mermaid-fix-btn";
      btn.onclick = onClick;
      return btn;
    };

    footer.appendChild(createButton("以後自動適用", () => { this.close(); this.opts.onAutoApply(); }));
    const replaceBtn = createButton("置換", () => { this.close(); this.opts.onReplace(); }, true);
    replaceBtn.classList.add("mermaid-fix-btn-replace");
    footer.appendChild(replaceBtn);

    this.modal.appendChild(header);
    this.modal.appendChild(content);
    this.modal.appendChild(footer);
  }

  private createDiffView(original: string, modified: string): HTMLElement {
    const container = document.createElement("div");
    const diffLines = calculateDiff(original, modified);
    
    diffLines.forEach(line => {
      const lineElement = document.createElement("div");
      lineElement.className = `mermaid-fix-diff-line ${line.type}`;
      
      const lineNumber = document.createElement("span");
      lineNumber.className = "mermaid-fix-diff-line-number";
      lineNumber.textContent = line.lineNumber?.toString() || "";
      
      const content = document.createElement("span");
      content.textContent = line.content;
      
      lineElement.appendChild(lineNumber);
      lineElement.appendChild(content);
      container.appendChild(lineElement);
    });
    
    return container;
  }

  private switchToSideBySideMode(): void {
    console.log("Switching to side-by-side mode");
    if (this.currentMode === 'side-by-side') return;
    this.currentMode = 'side-by-side';
    this.updateModeButtons();
    this.updateLayout();
  }

  private switchToInlineMode(): void {
    console.log("Switching to inline mode");
    if (this.currentMode === 'inline') return;
    this.currentMode = 'inline';
    this.updateModeButtons();
    this.updateLayout();
  }

  private updateModeButtons(): void {
    console.log("Updating mode buttons, current mode:", this.currentMode);
    const modeBtns = this.modal?.querySelectorAll('.mermaid-fix-mode-btn');
    modeBtns?.forEach(btn => {
      btn.classList.remove('active');
      if ((btn as HTMLElement).textContent === (this.currentMode === 'side-by-side' ? '左右比較' : '行内差分')) {
        btn.classList.add('active');
        console.log("Activated button:", (btn as HTMLElement).textContent);
      }
    });
  }

  private updateLayout(): void {
    if (!this.panelsContainer || !this.leftPanel || !this.rightPanel || !this.renderPanel) return;

    this.panelsContainer.innerHTML = '';
    
    if (this.currentMode === 'side-by-side') {
      // 3カラムレイアウト
      this.panelsContainer.appendChild(this.leftPanel);
      this.panelsContainer.appendChild(this.rightPanel);
      this.panelsContainer.appendChild(this.renderPanel);
      this.panelsContainer.className = "mermaid-fix-panels";
    } else {
      // 2カラムレイアウト（差分表示 + レンダリング）
      const diffPanel = this.createInlineDiffPanel();
      this.panelsContainer.appendChild(diffPanel);
      this.panelsContainer.appendChild(this.renderPanel);
      this.panelsContainer.className = "mermaid-fix-panels mermaid-fix-inline-mode";
    }
  }

  private createInlineDiffPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "mermaid-fix-panel";
    
    const label = document.createElement("div");
    label.textContent = "修正後のコード（差分表示）";
    label.className = "mermaid-fix-label";
    
    const diffView = this.createDiffView(this.opts.original, this.opts.proposed);
    diffView.className = "mermaid-fix-diff";
    
    panel.appendChild(label);
    panel.appendChild(diffView);
    return panel;
  }

  private updateDiffDisplay(): void {
    console.log("Updating diff display, mode:", this.currentMode);
    
    if (this.currentMode === 'inline') {
      const diffView = this.panelsContainer?.querySelector('.mermaid-fix-diff');
      if (diffView) {
        const newDiffView = this.createDiffView(this.opts.original, this.opts.proposed);
        newDiffView.className = "mermaid-fix-diff";
        diffView.replaceWith(newDiffView);
        console.log("Updated inline diff view");
      }
    } else {
      // 左右比較モードでも差分ハイライトを適用
      this.updateSideBySideDiffHighlight();
    }
  }

  private updateSideBySideDiffHighlight(): void {
    console.log("Updating side-by-side diff highlight");
    // 左右比較モードでの差分ハイライト機能を実装予定
  }



  private onCodeEdit(newCode: string): void {
    // リアルタイムプレビュー更新
    const renderContainer = this.renderPanel?.querySelector('.mermaid-fix-render') as HTMLElement;
    if (renderContainer) {
      this.renderMermaid(renderContainer, newCode, "編集されたコード");
    }
    
    // エラーチェック
    this.validateCode(newCode);
    
    // 行内差分モードの場合は差分表示も更新
    if (this.currentMode === 'inline') {
      this.updateDiffDisplay();
    }
  }

  private async validateCode(code: string): Promise<void> {
    try {
      const m: any = (window as any).mermaid;
      if (!m) return;
      
      await m.parse(code);
      this.clearErrorDisplay();
    } catch (error: any) {
      this.showErrorDisplay(error.message || '構文エラーが発生しました');
    }
  }

  private showErrorDisplay(errorMessage: string): void {
    const errorContainer = this.modal?.querySelector('.mermaid-fix-error') as HTMLElement;
    if (errorContainer) {
      errorContainer.textContent = `エラー: ${errorMessage}`;
      errorContainer.style.display = 'block';
    }
  }

  private clearErrorDisplay(): void {
    const errorContainer = this.modal?.querySelector('.mermaid-fix-error') as HTMLElement;
    if (errorContainer) {
      errorContainer.style.display = 'none';
    }
  }

  private setupSyncScroll(leftElement: HTMLElement, rightElement: HTMLElement): void {
    let isScrolling = false;
    
    const syncScroll = (source: HTMLElement, target: HTMLElement) => {
      if (isScrolling) return;
      isScrolling = true;
      
      const scrollRatio = source.scrollTop / (source.scrollHeight - source.clientHeight);
      const targetScrollTop = scrollRatio * (target.scrollHeight - target.clientHeight);
      target.scrollTop = targetScrollTop;
      
      setTimeout(() => { isScrolling = false; }, 10);
    };
    
    leftElement.addEventListener('scroll', () => syncScroll(leftElement, rightElement));
    rightElement.addEventListener('scroll', () => syncScroll(rightElement, leftElement));
  }

  private async renderMermaid(container: HTMLElement, code: string, label: string): Promise<void> {
    try {
      const m: any = (window as any).mermaid;
      if (!m) {
        container.innerHTML = '<div style="color: var(--text-muted);">Mermaid が利用できません</div>';
        return;
      }
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      container.innerHTML = `<div class="mermaid" data-render-id="${id}"></div>`;
      const result = await m.render(id, code);
      if (result && result.svg) {
        const wrapper = container.querySelector('.mermaid');
        if (wrapper) (wrapper as HTMLElement).innerHTML = result.svg;
        const svg = container.querySelector('svg');
        if (svg) {
          (svg as SVGSVGElement).style.maxWidth = '100%';
          (svg as SVGSVGElement).style.maxHeight = '100%';
          (svg as SVGSVGElement).style.width = 'auto';
          (svg as SVGSVGElement).style.height = 'auto';
          (svg as SVGSVGElement).style.display = 'block';
          (svg as SVGSVGElement).style.margin = '0 auto';
        }
      } else {
        container.innerHTML = `<div style="color: var(--text-error);">レンダリングに失敗しました</div>`;
      }
    } catch (error) {
      console.error(`Mermaid rendering error for ${label}:`, error);
      container.innerHTML = `<div style=\"color: var(--text-error);\">レンダリングエラー: ${error instanceof Error ? error.message : String(error)}</div>`;
    }
  }

  private attachEventListeners(): void {
    // 外側クリック・ESCでは閉じない（バツでのみ閉じる）
  }
}

