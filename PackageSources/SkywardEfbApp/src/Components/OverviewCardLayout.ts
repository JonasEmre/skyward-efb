export function syncOverviewCardLayout(root: ParentNode): void {
    const squareCards = root.querySelectorAll<HTMLElement>(".skyward-overview-card");
    for (const card of squareCards) {
        const width = card.clientWidth;
        if (width > 0) {
            card.style.height = `${Math.round(width)}px`;
        }
    }

    const content = root.querySelector<HTMLElement>(".skyward-content");
    const mapCards = root.querySelectorAll<HTMLElement>(".skyward-overview-map-card");
    for (const card of mapCards) {
        const section = card.closest<HTMLElement>(".skyward-section--overview");
        const grid = section?.querySelector<HTMLElement>(".skyward-overview-grid");
        const meta = section?.querySelector<HTMLElement>(".skyward-meta-list");
        const sectionStyles = section ? window.getComputedStyle(section) : undefined;
        const sectionPaddingTop = sectionStyles ? parseFloat(sectionStyles.paddingTop) || 0 : 0;
        const sectionPaddingBottom = sectionStyles ? parseFloat(sectionStyles.paddingBottom) || 0 : 0;
        const sectionGap = sectionStyles ? parseFloat(sectionStyles.rowGap || sectionStyles.gap) || 0 : 0;
        const availableHeight = content
            ? content.clientHeight
                - sectionPaddingTop
                - sectionPaddingBottom
                - (grid?.offsetHeight ?? 0)
                - (meta?.offsetHeight ?? 0)
                - (sectionGap * 2)
            : card.clientWidth;

        const parentWidth = card.parentElement?.clientWidth ?? card.clientWidth;
        const size = Math.max(140, Math.min(parentWidth, availableHeight, 280));
        if (size > 0) {
            const rounded = Math.round(size);
            card.style.width = `${rounded}px`;
            card.style.height = `${rounded}px`;
        }
    }

    const panoramicCards = root.querySelectorAll<HTMLElement>(".skyward-overview-enroute");
    for (const card of panoramicCards) {
        const width = card.clientWidth;
        if (width > 0) {
            card.style.height = `${Math.round(width / 3)}px`;
        }
    }
}
