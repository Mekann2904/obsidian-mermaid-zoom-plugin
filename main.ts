import { Plugin, Notice, PluginSettingTab, App, Setting, EventRef } from "obsidian";

// --- 設定インターフェース ---
interface MermaidZoomPluginSettings {
  pngScale: number;
}

const DEFAULT_SETTINGS: MermaidZoomPluginSettings = {
  pngScale: 10,
};

export default class MermaidZoomPlugin extends Plugin {
  private currentModal: HTMLElement | null = null;
  settings: MermaidZoomPluginSettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    await this.injectCss();

    this.addSettingTab(new MermaidZoomSettingTab(this.app, this));

    this.registerDomEvent(document, "click", (event) => {
      const target = event.target as HTMLElement;
      const mermaidElement = target.closest(".mermaid") as HTMLElement;
      if (mermaidElement) {
        const sourceCodeBlock = this.findMermaidSource(mermaidElement);
        this.showPopup(mermaidElement, sourceCodeBlock);
      }
    });
  }

  /**
   * 【修正済み】プラグイン用のCSSをインライン<style>として<head>に挿入します。
   * CSPによる外部ファイルのブロックを回避します。
   */
  async injectCss() {
    const styleId = "mermaid-zoom-plugin-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    try {
      style.textContent = await this.app.vault.adapter.read(
        `${this.manifest.dir}/styles.css`
      );
      document.head.appendChild(style);
    } catch(e) {
      console.error("Mermaid Zoom Plugin: Failed to load styles.css.", e);
    }
  }

  /**
   * レンダリングされたMermaid要素から、元のコードブロックを探します。
   */
  findMermaidSource(mermaidEl: HTMLElement): HTMLElement | null {
    let previousEl = mermaidEl.previousElementSibling;
    if (previousEl && previousEl.querySelector("code.language-mermaid")) {
      return previousEl.querySelector("code.language-mermaid") as HTMLElement;
    }
    previousEl = mermaidEl.parentElement?.previousElementSibling ?? null;
    if (previousEl && previousEl.querySelector("code.language-mermaid")) {
      return previousEl.querySelector("code.language-mermaid") as HTMLElement;
    }
    return null;
  }

  /**
   * ポップアップモーダルを表示します。
   */
  showPopup(element: HTMLElement, sourceCodeEl: HTMLElement | null) {
    if (this.currentModal) {
      this.currentModal.remove();
    }

    // (モーダル表示のロジックは変更なし)
    let zoomLevel = 1;
    let isPanning = false;
    let panX = 0, panY = 0;
    let lastMouseX = 0, lastMouseY = 0;

    const modal = this.createElement("div", "mermaid-zoom-modal");
    const content = this.createElement("div", "mermaid-zoom-content");
    const clonedElement = element.cloneNode(true) as HTMLElement;
    clonedElement.className = "mermaid-zoom-clone";
    
    // ポップアップ内のSVGはコピー対象ではないため、テーマクラスの適用は維持
    const themeClass = document.body.classList.contains("theme-dark") ? "theme-dark" : "theme-light";
    clonedElement.classList.add(themeClass);
    const svg = clonedElement.querySelector("svg");
    if (svg) {
      svg.classList.add(themeClass);
    }

    const toolbar = this.createToolbar(
      () => closeModal(),
      // コピー機能にはクローンされた要素ではなく、元の `element` を渡す
      () => this.copyAsSvg(element), 
      () => this.copyAsPng(element)
    );
    
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
    document.body.appendChild(modal);
    this.currentModal = modal;

    // --- イベントリスナー ---
    let fileOpenRef: EventRef | null = null;
    const closeModal = () => {
      modal.remove();
      document.removeEventListener("keydown", handleKeyDown);
      if (fileOpenRef) {
        this.app.workspace.offref(fileOpenRef);
        fileOpenRef = null;
      }
      this.currentModal = null;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", handleKeyDown);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });

    // Mermaid内の内部リンクをクリックしたらモーダルを閉じる
    content.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const link = t.closest("a.internal-link, .internal-link, a[data-href], [data-href]") as HTMLElement | SVGAElement | null;
      if (!link) return;

      // 既存の動きを止めて自前で遷移
      e.preventDefault();
      e.stopPropagation();

      // SVG内リンクも考慮して href を抽出
      const getHref = (el: Element): string | null => {
        const dataHref = el.getAttribute("data-href");
        if (dataHref) return dataHref;
        // HTMLAnchorElement
        const hrefAttr = el.getAttribute("href");
        if (hrefAttr) return hrefAttr;
        // SVG <a> の href (SVGAnimatedString)
        const anyEl = el as any;
        if (anyEl && anyEl.href && typeof anyEl.href.baseVal === "string") {
          return anyEl.href.baseVal as string;
        }
        const xlink = el.getAttribute("xlink:href");
        if (xlink) return xlink;
        return null;
      };

      const target = getHref(link);
      if (!target) return;

      const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
      const newLeaf = (e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey;
      this.app.workspace.openLinkText(target, sourcePath, newLeaf);
      closeModal();
    });

    // ノート遷移（file-open）が発生したらモーダルを閉じる（保険）
    fileOpenRef = this.app.workspace.on("file-open", () => {
      if (this.currentModal) closeModal();
    });

    // (パン・ズーム処理は変更なし)
    content.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement)?.closest('a, .internal-link, [data-href]')) return; isPanning = true; content.classList.add('grabbing'); lastMouseX = e.pageX; lastMouseY = e.pageY; });
    content.addEventListener('mouseleave', () => { isPanning = false; content.classList.remove('grabbing'); });
    content.addEventListener('mouseup', () => { isPanning = false; content.classList.remove('grabbing'); });
    content.addEventListener('mousemove', (e) => { if (!isPanning) return; e.preventDefault(); const dx = e.pageX - lastMouseX; const dy = e.pageY - lastMouseY; panX += dx; panY += dy; lastMouseX = e.pageX; lastMouseY = e.pageY; updateTransform(); });
    const updateTransform = () => { clonedElement.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`; zoomDisplay.textContent = `${Math.round(zoomLevel * 100)}%`; };
    content.addEventListener("wheel", (e) => { e.preventDefault(); const delta = e.deltaY < 0 ? 0.2 : -0.2; zoomLevel = Math.max(0.2, zoomLevel + delta); updateTransform(); }, { passive: false });
    requestAnimationFrame(() => { const contentRect = content.getBoundingClientRect(); const cloneRect = clonedElement.getBoundingClientRect(); const scaleX = contentRect.width / cloneRect.width; const scaleY = contentRect.height / cloneRect.height; zoomLevel = Math.min(scaleX, scaleY) * 0.95; panX = 0; panY = 0; updateTransform(); });
  }

  // --- ヘルパーメソッド群 (変更なし) ---
  private createElement<K extends keyof HTMLElementTagNameMap>(tagName: K, className: string): HTMLElementTagNameMap[K] { const el = document.createElement(tagName); el.className = className; return el; }
  private createToolbar(onClose: () => void, onCopySvg: () => void, onCopyPng: () => void): HTMLElement { const toolbar = this.createElement("div", "mermaid-zoom-toolbar"); const closeButton = this.createButton("✖", "閉じる", onClose); const copySvgButton = this.createButton("SVG", "SVGをコピー", onCopySvg); const copyPngButton = this.createButton("PNG", "PNGをコピー", onCopyPng); toolbar.append(copySvgButton, copyPngButton, closeButton); return toolbar; }
  private createZoomControls(getZoom: () => number, onZoom: (zoom: number, panX?: number, panY?: number) => void) { const zoomOutButton = this.createButton("－", "縮小", () => onZoom(Math.max(0.2, getZoom() - 0.2))); const zoomInButton = this.createButton("＋", "拡大", () => onZoom(getZoom() + 0.2)); const resetZoomButton = this.createButton("1:1", "リセット", () => onZoom(1.0, 0, 0)); const zoomDisplay = this.createElement("span", "zoom-display"); zoomDisplay.textContent = "100%"; return { zoomInButton, zoomOutButton, zoomDisplay, resetZoomButton }; }
  private createButton(text: string, title: string, onClick: () => void): HTMLButtonElement { const button = this.createElement("button", ""); button.textContent = text; button.title = title; button.addEventListener("click", (e) => { e.stopPropagation(); onClick(); }); return button; }

  /**
   * 【新規追加】オリジナルのSVGからスタイルをインライン化したクローンを生成します。
   * fill="none" を尊重し、線や矢印が黒く塗りつぶされる問題を回避します。
   */
  private cloneSvgWithInlineStyles(orig: SVGSVGElement): SVGSVGElement {
    const clone = orig.cloneNode(true) as SVGSVGElement;

    const traverse = (src: Element, dst: Element) => {
      const comp  = getComputedStyle(src);
      const props = ["stroke", "stroke-width", "opacity", "color", "font", "font-family", "font-size"] as const;

      // --- fill の扱いだけ特別 ---
      const origFillAttr = (src as HTMLElement).getAttribute("fill");
      const compFill     = comp.getPropertyValue("fill");

      if (origFillAttr && origFillAttr.trim() === "none") {
        // 元が none なら明示的に none を指定
        (dst as HTMLElement).setAttribute("fill", "none");
      } else if (compFill && compFill !== "rgba(0, 0, 0, 0)") {
        // none 以外ならインライン化
        (dst as HTMLElement).style.setProperty("fill", compFill);
      }
      // --------------------------------

      props.forEach(p => {
        const v = comp.getPropertyValue(p);
        if (v && v !== "none" && v !== "rgba(0, 0, 0, 0)") {
          (dst as HTMLElement).style.setProperty(p, v);
        }
      });

      Array.from(src.children).forEach((c, i) => traverse(c, dst.children[i]));
    };

    traverse(orig, clone);
    return clone;
  }

  /**
   * foreignObject を中心座標の <text> 要素に変換（Mermaid v10以降のhtmlLabels対応）
   */
  private replaceHtmlLabels(svg: SVGSVGElement) {
    svg.querySelectorAll("foreignObject").forEach(fo => {
      const span = fo.querySelector("span, div");
      const label = span?.textContent?.trim();
      if (!label) return;

      const x = parseFloat(fo.getAttribute("x") ?? "0");
      const y = parseFloat(fo.getAttribute("y") ?? "0");
      const w = parseFloat(fo.getAttribute("width")  ?? "0");
      const h = parseFloat(fo.getAttribute("height") ?? "0");

      const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textEl.setAttribute("x", (x + w / 2).toString());
      textEl.setAttribute("y", (y + h / 2).toString());
      textEl.setAttribute("text-anchor", "middle");
      textEl.setAttribute("dominant-baseline", "central");

      // 元divのスタイルを継承
      const comp = getComputedStyle(span as Element);
      ["font-family", "font-size", "font-weight", "fill", "color"].forEach(p => {
        textEl.style.setProperty(p, comp.getPropertyValue(p));
      });

      textEl.textContent = label;
      fo.parentNode?.replaceChild(textEl, fo);
    });
  }

  /**
   * 【修正済み】Mermaid図をSVGとしてクリップボードにコピーします。
   */
  private async copyAsSvg(originalContainerEl: HTMLElement) {
    const srcSvg = originalContainerEl.querySelector("svg");
    if (!srcSvg) {
      new Notice("SVG要素が見つかりませんでした。");
      return;
    }

    const svgClone = this.cloneSvgWithInlineStyles(srcSvg);
    this.replaceHtmlLabels(svgClone);
    svgClone.removeAttribute("class"); // テーマ依存のclassを除去

    if (!svgClone.hasAttribute("viewBox")) {
      const { width, height } = srcSvg.getBBox();
      svgClone.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
    if (!svgClone.hasAttribute("width") || !svgClone.hasAttribute("height")) {
      const rect = srcSvg.getBoundingClientRect();
      svgClone.setAttribute("width", rect.width.toString());
      svgClone.setAttribute("height", rect.height.toString());
    }
    const data = new XMLSerializer().serializeToString(svgClone);
    await navigator.clipboard.writeText(data);
    new Notice("SVGデータをクリップボードにコピーしました。");
  }

  /**
   * 【修正済み】Mermaid図をPNGとしてクリップボードにコピーします。
   */
  private async copyAsPng(originalContainerEl: HTMLElement) {
    const srcSvg = originalContainerEl.querySelector("svg");
    if (!srcSvg) {
      new Notice("SVG要素が見つかりませんでした。");
      return;
    }
    new Notice("PNGに変換中…");
    try {
      const svgClone = this.cloneSvgWithInlineStyles(srcSvg);
      this.replaceHtmlLabels(svgClone);
      const { width, height } = srcSvg.getBoundingClientRect();
      // --- 高解像度出力用スケール係数（設定から取得） ---
      const scale = this.settings.pngScale ?? 2;
      svgClone.setAttribute("width", `${width * scale}`);
      svgClone.setAttribute("height", `${height * scale}`);
      const svgData = new XMLSerializer().serializeToString(svgClone);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) { throw new Error("Canvasコンテキストの取得に失敗しました。"); }
      canvas.width = width * scale;
      canvas.height = height * scale;
      const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgData)))}`;
      const img = new Image();
      img.onload = () => {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(async (blob) => {
          if (!blob) { throw new Error("PNG Blobの生成に失敗しました。"); }
          await navigator.clipboard.write([ new ClipboardItem({ "image/png": blob }) ]);
          new Notice("PNG画像をクリップボードにコピーしました。");
        }, "image/png");
      };
      img.onerror = () => { throw new Error("PNGへの変換に失敗しました (画像読み込みエラー)。"); };
      img.src = dataUrl;
    } catch (error) {
      console.error("PNG copy failed:", error);
      new Notice(`PNGのコピーに失敗しました: ${error.message}`);
    }
  }
}

// --- 設定タブクラス ---
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
      .setDesc("PNGエクスポート時の解像度倍率（例: 2 で2倍、3で3倍）")
      .addText(text => text
        .setPlaceholder("2")
        .setValue(this.plugin.settings.pngScale.toString())
        .onChange(async (value) => {
          const num = Number(value);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.pngScale = num;
            await this.plugin.saveData(this.plugin.settings);
          }
        })
      );
  }
}
