import {
    AirportFacility,
    AirportClass,
    AdcEvents,
    AhrsEvents,
    BitFlags,
    AirportClassMask,
    ComponentProps,
    DisplayComponent,
    EventBus,
    FacilityLoader,
    FacilityRepository,
    FacilityWaypoint,
    FSComponent,
    GeoPoint,
    GNSSEvents,
    ICAO,
    MapCullableLocationTextLabel,
    MapOwnAirplaneIconOrientation,
    MapRotation,
    MapTerrainColorsModule,
    MapWaypointImageIcon,
    MapSystemBuilder,
    MapSystemKeys,
    MapSystemWaypointRoles,
    NearestAirportSearchSession,
    Subscription,
    UnitType,
    Vec2Math,
    Vec2Subject,
    VecNMath,
    VecNSubject,
    VNode,
    WaypointDisplayBuilder,
} from "@microsoft/msfs-sdk";
import { MsfsAirportDbPullDebug } from "../Debug/db_pull";

declare const BASE_URL: string;
declare const EBingReference: {
    SEA: unknown;
    AERIAL: unknown;
    PLANE: unknown;
};

interface SkywardOverviewMapProps extends ComponentProps {
    bus: EventBus;
}

class SkywardAirportWaypointBuilder {
    private static readonly DEFAULT_ICON_SIZE_PX = 22;
    private static readonly AIRPORT_ICON_URL =
        "coui://html_ui/Pages/VCockpit/Instruments/Shared/Map/Icons/ICON_MAP_AIRPORT7.svg";

    private readonly iconSize = Vec2Subject.create(
        Vec2Math.create(
            SkywardAirportWaypointBuilder.DEFAULT_ICON_SIZE_PX,
            SkywardAirportWaypointBuilder.DEFAULT_ICON_SIZE_PX,
        ),
    );
    private readonly airportIcon = new Image();

    constructor() {
        this.airportIcon.src = SkywardAirportWaypointBuilder.AIRPORT_ICON_URL;
    }

    public configure(builder: WaypointDisplayBuilder): void {
        builder
            .withSearchCenter("target")
            .addDefaultIcon<FacilityWaypoint<AirportFacility>>(MapSystemWaypointRoles.Normal, waypoint => this.createAirportIcon(waypoint))
            .addDefaultLabel<FacilityWaypoint<AirportFacility>>(MapSystemWaypointRoles.Normal, waypoint => this.createAirportLabel(waypoint));
    }

    private createAirportIcon(waypoint: FacilityWaypoint<AirportFacility>): MapWaypointImageIcon<FacilityWaypoint<AirportFacility>> {
        return new MapWaypointImageIcon(waypoint, 1, this.airportIcon, this.iconSize);
    }

    private createAirportLabel(waypoint: FacilityWaypoint<AirportFacility>): MapCullableLocationTextLabel {
        const facility = waypoint.facility.get();

        return new MapCullableLocationTextLabel(
            ICAO.getIdent(facility.icao),
            1,
            waypoint.location,
            false,
            {
                anchor: new Float64Array([0.5, 2.05]),
                font: "RobotoMono-Regular",
                fontSize: 12,
                fontColor: "white",
                bgColor: "rgba(6, 12, 24, 0.82)",
                bgPadding: new Float64Array([0, 3, 0, 3]),
                showBg: false,
            },
        );
    }
}

export class SkywardOverviewMap extends DisplayComponent<SkywardOverviewMapProps> {
    private static readonly DEFAULT_RANGE_NM = 25;
    private static readonly MIN_RANGE_NM = 2;
    private static readonly MAX_RANGE_NM = 6000;
    private static readonly MIN_AIRPORT_SEARCH_RANGE_NM = 50;
    private static readonly MAX_AIRPORT_SEARCH_RANGE_NM = 750;

    private readonly rootRef = FSComponent.createRef<HTMLDivElement>();
    private readonly debugPullButtonRef = FSComponent.createRef<HTMLButtonElement>();
    private readonly projectedSize = Vec2Subject.create(Vec2Math.create(100, 100));
    private readonly deadZone = VecNSubject.create(VecNMath.create(4));
    private readonly aircraftPosition = new GeoPoint(0, 0);
    private readonly dragVector = Vec2Math.create();
    private readonly dragGeoPoint = new GeoPoint(0, 0);
    private readonly subscriptions: Subscription[] = [];
    private readonly facilityRepository = FacilityRepository.getRepository(this.props.bus);
    private readonly facilityLoader = new FacilityLoader(this.facilityRepository);
    private readonly airportWaypointBuilder = new SkywardAirportWaypointBuilder();
    private readonly debugDbPull = new MsfsAirportDbPullDebug(this.facilityLoader);

    private readonly mapSystem = MapSystemBuilder.create(this.props.bus)
        .withProjectedSize(this.projectedSize)
        .withDeadZone(this.deadZone)
        .withRange(UnitType.NMILE.createNumber(SkywardOverviewMap.DEFAULT_RANGE_NM))
        .withModule(MapSystemKeys.TerrainColors, () => new MapTerrainColorsModule())
        .withContext(MapSystemKeys.FacilityLoader, () => this.facilityLoader)
        .withBing("skyward_overview_map")
        .withClockUpdate(30)
        .withFollowAirplane()
        .withRotation()
        .withOwnAirplanePropBindings(["position", "trackTrue", "groundSpeed", "isOnGround", "magVar"], 30)
        .withNearestWaypoints(builder => this.airportWaypointBuilder.configure(builder))
        .withOwnAirplaneIcon(
            28,
            `${BASE_URL}/Assets/map-aircraft.svg`,
            Vec2Math.create(0.5, 0.5),
        )
        .withOwnAirplaneIconOrientation(MapOwnAirplaneIconOrientation.HeadingUp)
        .build("skyward-overview-map__surface");

    private resizeObserver?: ResizeObserver;
    private updateRaf?: number;
    private isAwake = true;
    private isDragging = false;
    private isFollowingAircraft = true;
    private hasValidGpsPosition = false;
    private lastDragX = 0;
    private lastDragY = 0;
    private mapRangeNm = SkywardOverviewMap.DEFAULT_RANGE_NM;

    private readonly boundWheelHandler = this.onMapWheel.bind(this);
    private readonly boundMouseDownHandler = this.onMapMouseDown.bind(this);
    private readonly boundMouseMoveHandler = this.onMapMouseMove.bind(this);
    private readonly boundMouseUpHandler = this.onMapMouseUp.bind(this);
    private readonly boundDebugPullClickHandler = this.onDebugPullButtonPressed.bind(this);

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
        if (this.debugPullButtonRef.instance) {
            this.debugPullButtonRef.instance.onclick = this.boundDebugPullClickHandler;
        }

        this.configureMapAppearance();
        this.configureAirportWaypointDisplay();
        this.bindPositionStreams();
        this.refreshLayout();
        this.refreshDebugPullButton();
        this.pushRange();
        this.startUpdateLoop();
        if (!this.isAwake) {
            this.mapSystem.ref.instance.sleep();
        }
    }

    public setAwakeState(isAwake: boolean): void {
        this.isAwake = isAwake;
        const mapInstance = this.mapSystem.ref.getOrDefault();
        if (!mapInstance) {
            return;
        }

        if (isAwake) {
            mapInstance.wake();
            this.refreshLayout();
            this.startUpdateLoop();
            return;
        }

        this.stopUpdateLoop();
        mapInstance.sleep();
    }

    public refreshLayout(): void {
        const root = this.rootRef.getOrDefault();
        if (!root) {
            return;
        }

        const width = Math.max(root.clientWidth, 1);
        const height = Math.max(root.clientHeight, 1);
        this.projectedSize.set(width, height);
    }

    private bindPositionStreams(): void {
        const ownAirplaneModule = this.mapSystem.context.model.getModule(MapSystemKeys.OwnAirplaneProps);
        this.setFollowState(true);

        const subscriber = this.props.bus.getSubscriber<GNSSEvents & AhrsEvents & AdcEvents>();
        this.subscriptions.push(
            subscriber.on("gps-position").handle(position => {
                this.aircraftPosition.set(position.lat, position.long);
                ownAirplaneModule.position.set(position.lat, position.long);
                this.debugDbPull.notifyGpsPosition(position.lat, position.long);
                if (!this.hasValidGpsPosition) {
                    this.hasValidGpsPosition = true;
                    this.refreshDebugPullButton();
                }
            }),
            subscriber.on("actual_hdg_deg_true").withPrecision(1).handle(heading => {
                ownAirplaneModule.hdgTrue.set(heading);
            }),
            subscriber.on("track_deg_true").withPrecision(1).handle(track => {
                ownAirplaneModule.trackTrue.set(track);
            }),
            subscriber.on("ground_speed").withPrecision(1).handle(speed => {
                ownAirplaneModule.groundSpeed.set(speed, UnitType.KNOT);
            }),
            subscriber.on("on_ground").handle(isOnGround => {
                ownAirplaneModule.isOnGround.set(isOnGround);
            }),
            subscriber.on("magvar").withPrecision(1).handle(magVar => {
                ownAirplaneModule.magVar.set(magVar);
            }),
        );
    }

    private configureMapAppearance(): void {
        const rotationModule = this.mapSystem.context.model.getModule(MapSystemKeys.Rotation);
        rotationModule.rotationType.set(MapRotation.NorthUp);

        try {
            const terrainColorsModule = this.mapSystem.context.model.getModule(MapSystemKeys.TerrainColors);
            (terrainColorsModule.reference as any).set(EBingReference.AERIAL);

            terrainColorsModule.showIsoLines.set(false);
        } catch {
            // Leave the default Bing reference intact if terrain color controls are unavailable.
        }
    }

    private configureAirportWaypointDisplay(): void {
        const waypointDisplayModule = this.mapSystem.context.model.getModule(MapSystemKeys.NearestWaypoints);

        waypointDisplayModule.showAirports.set(() => true);
        waypointDisplayModule.showIntersections.set(() => false);
        waypointDisplayModule.showNdbs.set(() => false);
        waypointDisplayModule.showVors.set(() => false);
        waypointDisplayModule.airportsFilter.set({
            classMask: BitFlags.union(
                AirportClassMask.HardSurface,
                AirportClassMask.SoftSurface,
                AirportClassMask.AllWater,
                AirportClassMask.HeliportOnly,
                AirportClassMask.Private,
            ),
            showClosed: NearestAirportSearchSession.Defaults.ShowClosed,
        });
        waypointDisplayModule.extendedAirportsFilter.set({
            approachTypeMask: NearestAirportSearchSession.Defaults.ApproachTypeMask,
            runwaySurfaceTypeMask: NearestAirportSearchSession.Defaults.SurfaceTypeMask,
            minimumRunwayLength: 0,
            toweredMask: NearestAirportSearchSession.Defaults.ToweredMask,
        });

        this.syncAirportDisplaySettings();
    }

    private syncAirportDisplaySettings(): void {
        const waypointDisplayModule = this.mapSystem.context.model.getModule(MapSystemKeys.NearestWaypoints);
        const searchRangeNm = this.getAirportSearchRangeNm();

        let airportLimit = 24;
        if (this.mapRangeNm > 150) {
            airportLimit = 80;
        } else if (this.mapRangeNm > 50) {
            airportLimit = 60;
        } else if (this.mapRangeNm > 15) {
            airportLimit = 40;
        }

        waypointDisplayModule.numAirports.set(airportLimit);
        waypointDisplayModule.airportsRange.set(searchRangeNm, UnitType.NMILE);
    }

    private getAirportSearchRangeNm(): number {
        return Math.min(
            SkywardOverviewMap.MAX_AIRPORT_SEARCH_RANGE_NM,
            Math.max(SkywardOverviewMap.MIN_AIRPORT_SEARCH_RANGE_NM, this.mapRangeNm * 3),
        );
    }

    private getAirportSearchLimit(): number {
        if (this.mapRangeNm > 150) {
            return 80;
        }
        if (this.mapRangeNm > 50) {
            return 60;
        }
        if (this.mapRangeNm > 15) {
            return 40;
        }
        return 24;
    }

    private setFollowState(isFollowingAircraft: boolean): void {
        this.isFollowingAircraft = isFollowingAircraft;
        const followModule = this.mapSystem.context.model.getModule(MapSystemKeys.FollowAirplane);
        followModule.isFollowing.set(isFollowingAircraft);
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

            this.mapSystem.ref.getOrDefault()?.update(time);
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

    private pushRange(): void {
        this.mapSystem.context.projection.set({
            range: UnitType.NMILE.convertTo(this.mapRangeNm, UnitType.GA_RADIAN),
        });
    }

    private onMapWheel(evt: WheelEvent): void {
        evt.preventDefault();
        const zoomFactor = evt.deltaY < 0 ? 0.82 : 1.18;
        const nextRange = this.mapRangeNm * zoomFactor;
        this.mapRangeNm = Math.min(
            SkywardOverviewMap.MAX_RANGE_NM,
            Math.max(SkywardOverviewMap.MIN_RANGE_NM, nextRange),
        );
        this.pushRange();
        this.syncAirportDisplaySettings();
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

        const deltaX = this.lastDragX - evt.clientX;
        const deltaY = this.lastDragY - evt.clientY;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
            return;
        }

        this.lastDragX = evt.clientX;
        this.lastDragY = evt.clientY;

        if (this.isFollowingAircraft) {
            this.setFollowState(false);
        }

        const projection = this.mapSystem.context.projection;
        Vec2Math.set(deltaX, deltaY, this.dragVector);
        Vec2Math.add(projection.getTargetProjected(), this.dragVector, this.dragVector);
        projection.invert(this.dragVector, this.dragGeoPoint);
        projection.set({ target: this.dragGeoPoint });

        this.rootRef.instance.classList.add("skyward-overview-map--dragging");
    }

    private onMapMouseUp(): void {
        if (!this.isDragging) {
            return;
        }

        this.isDragging = false;
        this.rootRef.instance.classList.remove("skyward-overview-map--dragging");
    }

    private onDebugPullButtonPressed(): void {
        const result = this.debugDbPull.startManualExport();
        const button = this.debugPullButtonRef.getOrDefault();
        if (!button) {
            return;
        }

        if (result === "waiting_gps") {
            button.textContent = "Waiting GPS";
            return;
        }
        if (result === "busy") {
            button.textContent = "Pulling...";
            button.disabled = true;
            return;
        }

        button.textContent = "Pulling...";
        button.disabled = true;
    }

    private refreshDebugPullButton(): void {
        const button = this.debugPullButtonRef.getOrDefault();
        if (!button) {
            return;
        }

        button.disabled = !this.hasValidGpsPosition;
        button.textContent = this.hasValidGpsPosition ? "DB Pull" : "Waiting GPS";
    }

    public render(): VNode {
        return (
            <div ref={this.rootRef} class="skyward-overview-map">
                {this.mapSystem.map}
                <div class="skyward-overview-map__controls">
                    <button
                        ref={this.debugPullButtonRef}
                        class="skyward-overview-map__debug-button"
                        type="button"
                        disabled
                    >
                        Waiting GPS
                    </button>
                </div>
            </div>
        );
    }

    public destroy(): void {
        this.stopUpdateLoop();
        this.resizeObserver?.disconnect();
        for (const subscription of this.subscriptions) {
            subscription.destroy();
        }

        const root = this.rootRef.getOrDefault();
        if (root) {
            root.onwheel = null;
            root.onmousedown = null;
            root.onmousemove = null;
            root.onmouseup = null;
            root.onmouseleave = null;
        }
        if (this.debugPullButtonRef.instance) {
            this.debugPullButtonRef.instance.onclick = null;
        }

        this.debugDbPull.destroy();
        this.mapSystem.ref.getOrDefault()?.destroy();
        super.destroy();
    }
}
