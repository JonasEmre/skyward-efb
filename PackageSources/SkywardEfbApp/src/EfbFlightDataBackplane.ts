import {
    AdcPublisher,
    AhrsPublisher,
    ClockPublisher,
    EventBus,
    GNSSPublisher,
    InstrumentBackplane,
} from "@microsoft/msfs-sdk";

export class EfbFlightDataBackplane {
    private static readonly INSTANCE = new EfbFlightDataBackplane();

    public static get instance(): EfbFlightDataBackplane {
        return EfbFlightDataBackplane.INSTANCE;
    }

    private readonly backplane = new InstrumentBackplane();
    private isInitialized = false;
    private bus?: EventBus;

    private constructor() {
        // Singleton.
    }

    public initialize(bus: EventBus): void {
        if (this.isInitialized) {
            return;
        }

        this.bus = bus;
        this.backplane.addPublisher("clock", new ClockPublisher(bus));
        this.backplane.addPublisher("gnss", new GNSSPublisher(bus));
        this.backplane.addPublisher("ahrs", new AhrsPublisher(bus));
        this.backplane.addPublisher("adc", new AdcPublisher(bus));
        this.backplane.init();
        this.isInitialized = true;
    }

    public update(): void {
        if (!this.isInitialized || !this.bus) {
            return;
        }

        this.backplane.onUpdate();
    }
}
