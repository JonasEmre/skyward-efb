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
        const desiredHeight = parentWidth;
        const minimumHeight = Math.min(220, availableHeight);
        const height = Math.max(minimumHeight, Math.min(desiredHeight, availableHeight));
        if (parentWidth > 0 && height > 0) {
            card.style.width = `${Math.round(parentWidth)}px`;
            card.style.height = `${Math.round(height)}px`;
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
