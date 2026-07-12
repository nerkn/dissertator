// Zoom + scale constants shared by the PdfViewer and its controls toolbar.
// Discrete steps so +/- behave predictably and the scale always snaps to a
// render-friendly value.

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;
export const ZOOM_STEP = 0.25;

/** Initial render scale (before fit-to-width kicks in). */
export const DEFAULT_SCALE = 1.5;
