export type PanelOrientation = "horizontal" | "vertical";

export interface PanelLayoutState {
    panelWidth: number;
    panelHeight: number;
    orientation: PanelOrientation;
    densityScale: number;
}

const HORIZONTAL_BASELINE = { width: 1645, height: 999 };
const VERTICAL_BASELINE = { width: 999, height: 1645 };

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function resolvePanelElement(root: HTMLElement): HTMLElement {
    const panel = document.querySelector<HTMLElement>('[data-input-group="efb-panel-ui"]');
    if (panel && panel.clientWidth > 8 && panel.clientHeight > 8) {
        return panel;
    }
    return root;
}

function measurePanelLayout(root: HTMLElement): PanelLayoutState {
    const panelElement = resolvePanelElement(root);
    const panelWidth = Math.max(panelElement.clientWidth || root.clientWidth || 0, 1);
    const panelHeight = Math.max(panelElement.clientHeight || root.clientHeight || 0, 1);
    const orientation: PanelOrientation = panelWidth > panelHeight ? "horizontal" : "vertical";
    const baseline = orientation === "horizontal" ? HORIZONTAL_BASELINE : VERTICAL_BASELINE;
    const densityScale = clamp(
        Math.min(panelWidth / baseline.width, panelHeight / baseline.height),
        0.48,
        1,
    );

    return {
        panelWidth,
        panelHeight,
        orientation,
        densityScale,
    };
}

function applyPanelLayout(root: HTMLElement, state: PanelLayoutState): void {
    root.dataset.panelOrientation = state.orientation;
    root.style.setProperty("--skyward-panel-width", `${Math.round(state.panelWidth)}px`);
    root.style.setProperty("--skyward-panel-height", `${Math.round(state.panelHeight)}px`);
    root.style.setProperty("--skyward-density-scale", state.densityScale.toFixed(4));
}

export class PanelLayoutController {
    private resizeObserver?: ResizeObserver;
    private observedPanel?: HTMLElement;
    private refreshRaf?: number;

    public constructor(
        private readonly root: HTMLElement,
        private readonly onChange?: (state: PanelLayoutState) => void,
    ) { }

    public start(): void {
        this.bindObservedElements();
        window.addEventListener("resize", this.handleWindowResize);
        this.refresh();
    }

    public destroy(): void {
        window.removeEventListener("resize", this.handleWindowResize);
        if (this.refreshRaf !== undefined) {
            window.cancelAnimationFrame(this.refreshRaf);
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = undefined;
        }
        this.observedPanel = undefined;
    }

    public refresh(): void {
        this.bindObservedElements();
        const state = measurePanelLayout(this.root);
        applyPanelLayout(this.root, state);
        this.onChange?.(state);
    }

    private readonly handleWindowResize = (): void => {
        this.scheduleRefresh();
    };

    private scheduleRefresh(): void {
        if (this.refreshRaf !== undefined) {
            window.cancelAnimationFrame(this.refreshRaf);
        }

        this.refreshRaf = window.requestAnimationFrame(() => {
            this.refreshRaf = undefined;
            this.refresh();
        });
    }

    private bindObservedElements(): void {
        if (typeof ResizeObserver === "undefined") {
            return;
        }

        const nextPanel = resolvePanelElement(this.root);
        if (this.resizeObserver && this.observedPanel === nextPanel) {
            return;
        }

        this.resizeObserver?.disconnect();
        this.resizeObserver = new ResizeObserver(() => {
            this.scheduleRefresh();
        });
        this.resizeObserver.observe(this.root);
        if (nextPanel !== this.root) {
            this.resizeObserver.observe(nextPanel);
        }
        this.observedPanel = nextPanel;
    }
}
