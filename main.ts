import { Plugin, Notice } from "obsidian";

export default class MermaidZoomPlugin extends Plugin {
  private currentModal: HTMLElement | null = null;

  onload() {
    this.injectCss(); // スタイルをドキュメントに適用

    this.registerDomEvent(document, "click", (event) => {
      const target = event.target as HTMLElement;
      const mermaidElement = target.closest(".mermaid") as HTMLElement;
      if (mermaidElement) {
        // 元のMermaidコードブロックを探す
        const sourceCodeBlock = this.findMermaidSource(mermaidElement);
        this.showPopup(mermaidElement, sourceCodeBlock);
      }
    });
  }

  /**
   * プラグイン用のCSSを<head>に挿入します。
   */
  injectCss() {
    const styleId = "mermaid-zoom-plugin-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("link");
    style.id = styleId;
    style.rel = "stylesheet";
    style.type = "text/css";
    style.href = this.app.vault.adapter.getResourcePath(`${this.manifest.dir}/styles.css`);
    document.head.appendChild(style);
  }

  /**
   * レンダリングされたMermaid要素から、元のコードブロックを探します。
   * @param mermaidEl 描画されたMermaidのHTMLElement
   * @returns 元のコードが含まれる要素 (なければnull)
   */
  findMermaidSource(mermaidEl: HTMLElement): HTMLElement | null {
    // Obsidianの構造上、描画された要素の直前かその親の直前にコードブロックがある
    let previousEl = mermaidEl.previousElementSibling;
    if (previousEl && previousEl.querySelector("code.language-mermaid")) {
        return previousEl.querySelector("code.language-mermaid") as HTMLElement;
    }
    // 親要素のさらに前も探す
    previousEl = mermaidEl.parentElement?.previousElementSibling ?? null;
     if (previousEl && previousEl.querySelector("code.language-mermaid")) {
        return previousEl.querySelector("code.language-mermaid") as HTMLElement;
    }
    return null;
  }


  /**
   * ポップアップモーダルを表示します。
   * @param element クリックされたMermaid要素
   * @param sourceCodeEl Mermaidのソースコードが含まれる要素
   */
  showPopup(element: HTMLElement, sourceCodeEl: HTMLElement | null) {
    if (this.currentModal) {
      this.currentModal.remove();
    }

    let zoomLevel = 1;
    let isPanning = false;
    let panX = 0, panY = 0;
    let lastMouseX = 0, lastMouseY = 0;

    // --- 各種要素の作成 ---
    const modal = this.createElement("div", "mermaid-zoom-modal");
    const content = this.createElement("div", "mermaid-zoom-content");
    const clonedElement = element.cloneNode(true) as HTMLElement;
    clonedElement.className = "mermaid-zoom-clone";

    // ObsidianのテーマクラスをクローンSVGにも付与
    const themeClass = document.body.classList.contains("theme-dark") ? "theme-dark" : "theme-light";
    clonedElement.classList.add(themeClass);
    const svg = clonedElement.querySelector("svg");
    if (svg) {
      svg.classList.add(themeClass);
    }

    const toolbar = this.createToolbar(
      () => closeModal(),
      () => this.copyAsSvg(clonedElement),
      () => this.copyAsPng(clonedElement)
    );
    
    // --- ズームコントロールの作成 ---
    const { zoomInButton, zoomOutButton, zoomDisplay, resetZoomButton } = this.createZoomControls(() => zoomLevel, (newZoom) => {
      zoomLevel = newZoom;
      updateTransform();
    });
    toolbar.append(zoomOutButton, zoomDisplay, zoomInButton, resetZoomButton);

    content.appendChild(clonedElement);
    modal.append(toolbar, content);
    document.body.appendChild(modal);
    this.currentModal = modal;

    // --- イベントリスナー設定 ---
    const closeModal = () => {
      modal.remove();
      document.removeEventListener("keydown", handleKeyDown);
      this.currentModal = null;
    };
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", handleKeyDown);
    
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });

    // --- パンニング（ドラッグ移動）処理 ---
    content.addEventListener('mousedown', (e) => {
        isPanning = true;
        content.classList.add('grabbing');
        lastMouseX = e.pageX;
        lastMouseY = e.pageY;
    });

    content.addEventListener('mouseleave', () => {
        isPanning = false;
        content.classList.remove('grabbing');
    });

    content.addEventListener('mouseup', () => {
        isPanning = false;
        content.classList.remove('grabbing');
    });

    content.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        e.preventDefault();
        const dx = e.pageX - lastMouseX;
        const dy = e.pageY - lastMouseY;
        panX += dx;
        panY += dy;
        lastMouseX = e.pageX;
        lastMouseY = e.pageY;
        updateTransform();
    });

    // --- ズーム処理 ---
    const updateTransform = (newZoomLevel?: number) => {
        if (newZoomLevel) zoomLevel = newZoomLevel;
        clonedElement.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
        zoomDisplay.textContent = `${Math.round(zoomLevel * 100)}%`;
    };

    content.addEventListener("wheel", (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.2 : -0.2;
        zoomLevel = Math.max(0.2, zoomLevel + delta);
        updateTransform();
      }, { passive: false }
    );

    // --- 初期表示時の自動ズーム ---
    requestAnimationFrame(() => {
        const contentRect = content.getBoundingClientRect();
        const cloneRect = clonedElement.getBoundingClientRect();
        const scaleX = contentRect.width / cloneRect.width;
        const scaleY = contentRect.height / cloneRect.height;
        const initialZoom = Math.min(scaleX, scaleY) * 0.95;
        zoomLevel = initialZoom;
        panX = 0;
        panY = 0;
        updateTransform();
    });
  }

  // --- ヘルパーメソッド群 ---

  /**
   * 指定したクラス名を持つHTMLElementを生成します。
   */
  private createElement<K extends keyof HTMLElementTagNameMap>(tagName: K, className: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tagName);
    el.className = className;
    return el;
  }

  /**
   * 操作用のツールバーを生成します。
   */
  private createToolbar(onClose: () => void, onCopySvg: () => void, onCopyPng: () => void): HTMLElement {
    const toolbar = this.createElement("div", "mermaid-zoom-toolbar");
    const closeButton = this.createButton("✖", "閉じる", onClose);
    const copySvgButton = this.createButton("SVG", "SVGをコピー", onCopySvg);
    const copyPngButton = this.createButton("PNG", "PNGをコピー", onCopyPng);
    toolbar.append(copySvgButton, copyPngButton, closeButton);
    return toolbar;
  }

  /**
   * ズーム関連のコントロールを生成します。
   */
  private createZoomControls(getZoom: () => number, onZoom: (zoom: number) => void) {
    const zoomOutButton = this.createButton("－", "縮小", () => onZoom(Math.max(0.2, getZoom() - 0.2)));
    const zoomInButton = this.createButton("＋", "拡大", () => onZoom(getZoom() + 0.2));
    const resetZoomButton = this.createButton("1:1", "リセット", () => {
        // 初期表示時の自動ズームを再実行するロジックをここに入れるか、単に1に戻す
        onZoom(1.0); 
    });
    
    const zoomDisplay = this.createElement("span", "zoom-display");
    zoomDisplay.textContent = "100%";

    return { zoomInButton, zoomOutButton, zoomDisplay, resetZoomButton };
  }
  
  /**
   * ボタン要素を生成します。
   */
  private createButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = this.createElement("button", "");
    button.textContent = text;
    button.title = title;
    button.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
    });
    return button;
  }

  /**
   * Mermaid図をSVGとしてクリップボードにコピーします。
   */
  private async copyAsSvg(containerEl: HTMLElement) {
    const svgEl = containerEl.querySelector("svg");
    if (!svgEl) {
      new Notice("SVG要素が見つかりませんでした。");
      return;
    }
    const svgData = new XMLSerializer().serializeToString(svgEl);
    await navigator.clipboard.writeText(svgData);
    new Notice("SVGデータをクリップボードにコピーしました。");
  }

  /**
   * Mermaid図をPNGとしてクリップボードにコピーします。
   */
  private async copyAsPng(containerEl: HTMLElement) {
    const svgEl = containerEl.querySelector("svg");
    if (!svgEl) {
      new Notice("SVG要素が見つかりませんでした。");
      return;
    }
    
    new Notice("PNGに変換中...");

    try {
        const svgData = new XMLSerializer().serializeToString(svgEl);
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if(!ctx) return;

        const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(svgBlob);

        const img = new Image();
        img.onload = async () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);

            canvas.toBlob(async (blob) => {
                if (blob) {
                    await navigator.clipboard.write([
                        new ClipboardItem({ "image/png": blob }),
                    ]);
                    new Notice("PNG画像をクリップボードにコピーしました。");
                }
            }, "image/png");
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            new Notice("PNGへの変換に失敗しました。");
        };
        img.src = url;

    } catch (error) {
        console.error("PNG copy failed:", error);
        new Notice("PNGのコピーに失敗しました。");
    }
  }
}