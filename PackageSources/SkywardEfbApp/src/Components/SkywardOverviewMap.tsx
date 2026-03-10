import {
    AdcEvents,
    AhrsEvents,
    ComponentProps,
    DisplayComponent,
    EventBus,
    FSComponent,
    GeoPoint,
    GNSSEvents,
    MapOwnAirplaneIconOrientation,
    MapRotation,
    MapTerrainColorsModule,
    MapSystemBuilder,
    MapSystemKeys,
    Subscription,
    UnitType,
    Vec2Math,
    Vec2Subject,
    VecNMath,
    VecNSubject,
    VNode,
} from "@microsoft/msfs-sdk";

declare const BASE_URL: string;
declare const EBingReference: {
    SEA: unknown;
    AERIAL: unknown;
    PLANE: unknown;
};

interface SkywardOverviewMapProps extends ComponentProps {
    bus: EventBus;
}

export class SkywardOverviewMap extends DisplayComponent<SkywardOverviewMapProps> {
    private static readonly DEFAULT_RANGE_NM = 25;
    private static readonly MIN_RANGE_NM = 2;
    private static readonly MAX_RANGE_NM = 6000;

    private readonly rootRef = FSComponent.createRef<HTMLDivElement>();
    private readonly projectedSize = Vec2Subject.create(Vec2Math.create(100, 100));
    private readonly deadZone = VecNSubject.create(VecNMath.create(4));
    private readonly aircraftPosition = new GeoPoint(0, 0);
    private readonly dragVector = Vec2Math.create();
    private readonly dragGeoPoint = new GeoPoint(0, 0);
    private readonly subscriptions: Subscription[] = [];

    private readonly mapSystem = MapSystemBuilder.create(this.props.bus)
        .withProjectedSize(this.projectedSize)
        .withDeadZone(this.deadZone)
        .withRange(UnitType.NMILE.createNumber(SkywardOverviewMap.DEFAULT_RANGE_NM))
        .withModule(MapSystemKeys.TerrainColors, () => new MapTerrainColorsModule())
        .withBing("skyward_overview_map")
        .withClockUpdate(30)
        .withFollowAirplane()
        .withRotation()
        .withOwnAirplanePropBindings(["position", "trackTrue", "groundSpeed", "isOnGround", "magVar"], 30)
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
    private lastDragX = 0;
    private lastDragY = 0;
    private mapRangeNm = SkywardOverviewMap.DEFAULT_RANGE_NM;

    private readonly boundWheelHandler = this.onMapWheel.bind(this);
    private readonly boundMouseDownHandler = this.onMapMouseDown.bind(this);
    private readonly boundMouseMoveHandler = this.onMapMouseMove.bind(this);
    private readonly boundMouseUpHandler = this.onMapMouseUp.bind(this);

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

        this.configureMapAppearance();
        this.bindPositionStreams();
        this.refreshLayout();
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

    public render(): VNode {
        return (
            <div ref={this.rootRef} class="skyward-overview-map">
                {this.mapSystem.map}
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

        this.mapSystem.ref.getOrDefault()?.destroy();
        super.destroy();
    }
}
