import {
    ArraySubject,
    BingComponent,
    ComponentProps,
    DisplayComponent,
    EventBus,
    FSComponent,
    Subject,
    Vec2Math,
    Vec2Subject,
    VNode,
} from "@microsoft/msfs-sdk";

declare const BASE_URL: string;
declare const SimVar: {
    GetSimVarValue: (name: string, unit: string) => number;
};
declare const EBingMode: any;

interface SkywardOverviewMapProps extends ComponentProps {
    bus: EventBus;
}

export class SkywardOverviewMap extends DisplayComponent<SkywardOverviewMapProps> {
    private static readonly EARTH_RADIUS_METERS = 6378137;
    private static readonly DEFAULT_RADIUS_METERS = 46300;
    private static readonly MIN_RADIUS_METERS = 2500;
    private static readonly MAX_RADIUS_METERS = 400000;

    private readonly rootRef = FSComponent.createRef<HTMLDivElement>();
    private readonly bingRef = FSComponent.createRef<BingComponent>();
    private readonly aircraftRef = FSComponent.createRef<HTMLImageElement>();
    private readonly hintRef = FSComponent.createRef<HTMLDivElement>();
    private readonly followButtonRef = FSComponent.createRef<HTMLButtonElement>();
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
    private isFollowingAircraft = true;
    private isDragging = false;
    private lastDragX = 0;
    private lastDragY = 0;
    private mapRadiusMeters = SkywardOverviewMap.DEFAULT_RADIUS_METERS;
    private mapCenterLat = NaN;
    private mapCenterLon = NaN;
    private readonly boundWheelHandler = this.onMapWheel.bind(this);
    private readonly boundMouseDownHandler = this.onMapMouseDown.bind(this);
    private readonly boundMouseMoveHandler = this.onMapMouseMove.bind(this);
    private readonly boundMouseUpHandler = this.onMapMouseUp.bind(this);
    private readonly boundFollowClickHandler = this.onFollowButtonClick.bind(this);
    private readonly boundFollowMouseDownHandler = (evt: MouseEvent): void => {
        evt.stopPropagation();
    };

    public onAfterRender(): void {
        const root = this.rootRef.instance;
        if (typeof ResizeObserver !== "undefined" && root) {
            this.resizeObserver = new ResizeObserver(() => {
                this.refreshLayout();
            });
            this.resizeObserver.observe(root);
        }

        if (root) {
            root.onwheel = this.boundWheelHandler;
            root.onmousedown = this.boundMouseDownHandler;
            root.onmousemove = this.boundMouseMoveHandler;
            root.onmouseup = this.boundMouseUpHandler;
            root.onmouseleave = this.boundMouseUpHandler;
        }

        const followButton = this.followButtonRef.getOrDefault();
        if (followButton) {
            followButton.onclick = this.boundFollowClickHandler;
            followButton.onmousedown = this.boundFollowMouseDownHandler;
        }

        this.refreshLayout();
        this.syncMapState();
        this.startUpdateLoop();
        if (!this.isAwake) {
            this.bingRef.instance.sleep();
        }

        this.updateUi();
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
            this.updateUi();
            return;
        }

        this.stopUpdateLoop();
        bing.sleep();
        this.updateUi();
    }

    public refreshLayout(): void {
        const root = this.rootRef.getOrDefault();
        if (!root) {
            return;
        }

        const width = Math.max(root.clientWidth, 1);
        const height = Math.max(root.clientHeight, 1);
        this.projectedSize.set(width, height);
        this.pushMapPosition();
        this.updateUi();
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
        const aircraftLat = SimVar.GetSimVarValue("PLANE LATITUDE", "degrees");
        const aircraftLon = SimVar.GetSimVarValue("PLANE LONGITUDE", "degrees");
        if (!Number.isFinite(aircraftLat) || !Number.isFinite(aircraftLon)) {
            return;
        }

        const headingTrue = SimVar.GetSimVarValue("PLANE HEADING DEGREES TRUE", "degrees");
        if (this.isFollowingAircraft || !Number.isFinite(this.mapCenterLat) || !Number.isFinite(this.mapCenterLon)) {
            this.mapCenterLat = aircraftLat;
            this.mapCenterLon = aircraftLon;
        }

        this.pushMapPosition();

        if (this.aircraftRef.instance) {
            const normalizedHeading = Number.isFinite(headingTrue) ? headingTrue : 0;
            this.aircraftRef.instance.style.transform = `translate(-50%, -50%) rotate(${normalizedHeading}deg)`;
        }

        this.updateUi();
    }

    private pushMapPosition(): void {
        const bing = this.bingRef.getOrDefault();
        if (!bing || !Number.isFinite(this.mapCenterLat) || !Number.isFinite(this.mapCenterLon)) {
            return;
        }

        bing.setPositionRadius({ lat: this.mapCenterLat, long: this.mapCenterLon } as any, this.mapRadiusMeters);
    }

    private updateUi(): void {
        const hint = this.hintRef.getOrDefault();
        if (hint) {
            hint.textContent = this.isFollowingAircraft
                ? "Wheel: zoom  |  Drag: free pan"
                : "Free pan active  |  Follow aircraft to recenter";
        }

        const followButton = this.followButtonRef.getOrDefault();
        if (followButton) {
            followButton.classList.toggle("skyward-overview-map__control-button--hidden", this.isFollowingAircraft);
        }
    }

    private onMapWheel(evt: WheelEvent): void {
        evt.preventDefault();
        const zoomFactor = evt.deltaY < 0 ? 0.82 : 1.18;
        const nextRadius = this.mapRadiusMeters * zoomFactor;
        this.mapRadiusMeters = Math.min(
            SkywardOverviewMap.MAX_RADIUS_METERS,
            Math.max(SkywardOverviewMap.MIN_RADIUS_METERS, nextRadius),
        );
        this.pushMapPosition();
        this.updateUi();
    }

    private onMapMouseDown(evt: MouseEvent): void {
        if (evt.button !== 0) {
            return;
        }

        const target = evt.target;
        if (target instanceof HTMLElement && target.closest(".skyward-overview-map__controls")) {
            return;
        }

        evt.preventDefault();
        this.isDragging = true;
        this.lastDragX = evt.clientX;
        this.lastDragY = evt.clientY;
        this.rootRef.instance.classList.add("skyward-overview-map--dragging");
    }

    private onMapMouseMove(evt: MouseEvent): void {
        if (!this.isDragging) {
            return;
        }

        const deltaX = evt.clientX - this.lastDragX;
        const deltaY = evt.clientY - this.lastDragY;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
            return;
        }

        this.lastDragX = evt.clientX;
        this.lastDragY = evt.clientY;
        this.isFollowingAircraft = false;
        this.panByPixels(deltaX, deltaY);
        this.rootRef.instance.classList.add("skyward-overview-map--dragging");
        this.updateUi();
    }

    private onMapMouseUp(): void {
        if (!this.isDragging) {
            return;
        }

        this.isDragging = false;
        this.rootRef.instance.classList.remove("skyward-overview-map--dragging");
    }

    private panByPixels(deltaX: number, deltaY: number): void {
        if (!Number.isFinite(this.mapCenterLat) || !Number.isFinite(this.mapCenterLon)) {
            return;
        }

        const projectedSize = this.projectedSize.get();
        const viewportRadiusPixels = Math.max(Math.min(projectedSize[0], projectedSize[1]) * 0.5, 1);
        const metersPerPixel = this.mapRadiusMeters / viewportRadiusPixels;
        const eastMeters = -deltaX * metersPerPixel;
        const northMeters = deltaY * metersPerPixel;
        const latRad = this.mapCenterLat * Math.PI / 180;
        const nextLat = this.mapCenterLat + (northMeters / SkywardOverviewMap.EARTH_RADIUS_METERS) * 180 / Math.PI;
        const cosLat = Math.max(Math.cos(latRad), 0.1);
        const nextLon = this.mapCenterLon + (eastMeters / (SkywardOverviewMap.EARTH_RADIUS_METERS * cosLat)) * 180 / Math.PI;

        this.mapCenterLat = Math.max(-85, Math.min(85, nextLat));
        this.mapCenterLon = ((nextLon + 540) % 360) - 180;
        this.pushMapPosition();
    }

    private onFollowButtonClick(evt: MouseEvent): void {
        evt.preventDefault();
        evt.stopPropagation();
        this.isFollowingAircraft = true;
        this.syncMapState();
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
                        this.pushMapPosition();
                        this.updateUi();
                    }}
                />
                <img
                    ref={this.aircraftRef}
                    class="skyward-overview-map__aircraft"
                    src={`${BASE_URL}/Assets/map-aircraft.svg`}
                    alt=""
                />
                <div class="skyward-overview-map__controls">
                    <button
                        ref={this.followButtonRef}
                        type="button"
                        class="skyward-overview-map__control-button skyward-overview-map__control-button--hidden"
                    >
                        Follow Aircraft
                    </button>
                </div>
                <div ref={this.hintRef} class="skyward-overview-map__hint" />
            </div>
        );
    }

    public destroy(): void {
        this.stopUpdateLoop();
        this.resizeObserver?.disconnect();
        const root = this.rootRef.getOrDefault();
        if (root) {
            root.onwheel = null;
            root.onmousedown = null;
            root.onmousemove = null;
            root.onmouseup = null;
            root.onmouseleave = null;
        }
        const followButton = this.followButtonRef.getOrDefault();
        if (followButton) {
            followButton.onclick = null;
            followButton.onmousedown = null;
        }
        this.bingRef.getOrDefault()?.destroy();
        super.destroy();
    }
}
