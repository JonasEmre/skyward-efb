import {
    ArraySubject,
    BingComponent,
    ComponentProps,
    DisplayComponent,
    EventBus,
    FSComponent,
    GameStateProvider,
    Subject,
    Vec2Math,
    Vec2Subject,
    VNode,
} from "@microsoft/msfs-sdk";

declare const BASE_URL: string;
declare const SimVar: {
    GetSimVarValue: (name: string, unit: string) => number;
};
declare const EBingMode: {
    PLANE: number;
};
declare class LatLong {
    public constructor(lat: number, long: number);
}

interface SkywardOverviewMapProps extends ComponentProps {
    bus: EventBus;
}

export class SkywardOverviewMap extends DisplayComponent<SkywardOverviewMapProps> {
    private readonly rootRef = FSComponent.createRef<HTMLDivElement>();
    private readonly bingRef = FSComponent.createRef<BingComponent>();
    private readonly aircraftRef = FSComponent.createRef<HTMLImageElement>();
    private readonly statusRef = FSComponent.createRef<HTMLDivElement>();
    private readonly projectedSize = Vec2Subject.create(Vec2Math.create(100, 100));
    private readonly earthColors = ArraySubject.create(BingComponent.createEarthColorsArray("#6898E1", [
        { elev: 0, color: "#1f2937" },
        { elev: 2000, color: "#334155" },
        { elev: 8000, color: "#475569" },
        { elev: 14000, color: "#64748b" },
        { elev: 24000, color: "#94a3b8" },
    ]));
    private readonly skyColor = Subject.create(BingComponent.hexaToRGBColor("#08111d"));

    private resizeObserver?: ResizeObserver;
    private updateRaf?: number;
    private isAwake = true;
    private isBound = false;

    public onAfterRender(): void {
        if (typeof ResizeObserver !== "undefined" && this.rootRef.instance) {
            this.resizeObserver = new ResizeObserver(() => {
                this.refreshLayout();
            });
            this.resizeObserver.observe(this.rootRef.instance);
        }

        this.refreshLayout();
        this.syncMapState();
        this.startUpdateLoop();
        if (!this.isAwake) {
            this.bingRef.instance.sleep();
        }

        this.updateStatus();
    }

    public setAwakeState(isAwake: boolean): void {
        this.isAwake = isAwake;
        const bing = this.bingRef.getOrDefault();
        if (!bing) {
            return;
        }

        if (isAwake) {
            bing.wake();
            this.refreshLayout();
            this.startUpdateLoop();
            this.updateStatus();
            return;
        }

        this.stopUpdateLoop();
        bing.sleep();
        this.updateStatus();
    }

    public refreshLayout(): void {
        const root = this.rootRef.getOrDefault();
        if (!root) {
            return;
        }

        const width = Math.max(root.clientWidth, 1);
        const height = Math.max(root.clientHeight, 1);
        this.projectedSize.set(width, height);
        this.updateStatus();
    }

    private startUpdateLoop(): void {
        if (this.updateRaf !== undefined || !this.isAwake) {
            return;
        }

        const tick = (time: number): void => {
            this.updateRaf = undefined;
            if (!this.isAwake) {
                return;
            }

            this.syncMapState();
            this.updateRaf = window.requestAnimationFrame(tick);
        };

        this.updateRaf = window.requestAnimationFrame(tick);
    }

    private stopUpdateLoop(): void {
        if (this.updateRaf === undefined) {
            return;
        }

        window.cancelAnimationFrame(this.updateRaf);
        this.updateRaf = undefined;
    }

    private syncMapState(): void {
        const lat = SimVar.GetSimVarValue("PLANE LATITUDE", "degrees");
        const lon = SimVar.GetSimVarValue("PLANE LONGITUDE", "degrees");
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return;
        }

        const headingTrue = SimVar.GetSimVarValue("PLANE HEADING DEGREES TRUE", "degrees");
        const bing = this.bingRef.getOrDefault();
        if (bing) {
            bing.setPositionRadius(new LatLong(lat, lon), 46300);
        }

        if (this.aircraftRef.instance) {
            const normalizedHeading = Number.isFinite(headingTrue) ? headingTrue : 0;
            this.aircraftRef.instance.style.transform = `translate(-50%, -50%) rotate(${normalizedHeading}deg)`;
        }

        this.updateStatus(lat, lon);
    }

    private updateStatus(lat?: number, lon?: number): void {
        const statusNode = this.statusRef.getOrDefault();
        if (!statusNode) {
            return;
        }

        const size = this.projectedSize.get();
        const gameState = GameStateProvider.get().get();
        const parts = [
            this.isBound ? "Bing bound" : "Bing binding",
            this.isAwake ? "awake" : "sleep",
            `gs:${gameState ?? "none"}`,
            `px:${Math.round(size[0])}x${Math.round(size[1])}`,
        ];

        if (lat !== undefined && lon !== undefined) {
            parts.push(`${lat.toFixed(2)}, ${lon.toFixed(2)}`);
        }

        statusNode.textContent = parts.join(" | ");
    }

    public render(): VNode {
        return (
            <div ref={this.rootRef} class="skyward-overview-map">
                <BingComponent
                    ref={this.bingRef}
                    id="skyward_overview_map"
                    class="skyward-overview-map__bing"
                    mode={EBingMode.PLANE}
                    resolution={this.projectedSize}
                    earthColors={this.earthColors}
                    skyColor={this.skyColor}
                    delay={750}
                    onBoundCallback={(): void => {
                        this.isBound = true;
                        if (!this.isAwake) {
                            this.bingRef.instance.sleep();
                        }
                        this.updateStatus();
                    }}
                />
                <img
                    ref={this.aircraftRef}
                    class="skyward-overview-map__aircraft"
                    src={`${BASE_URL}/Assets/map-aircraft.svg`}
                    alt=""
                />
                <div ref={this.statusRef} class="skyward-overview-map__status" />
            </div>
        );
    }

    public destroy(): void {
        this.stopUpdateLoop();
        this.resizeObserver?.disconnect();
        this.bingRef.getOrDefault()?.destroy();
        super.destroy();
    }
}
