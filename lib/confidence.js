// Confidence level constants shared across all backends.

export const Confidence = Object.freeze({
    CONFIRMED: 'confirmed', // kernel PROCHOT interrupt — definitively thermal
    HIGH:      'high',      // throttled + package hot — thermal very likely
    MEDIUM:    'medium',    // freq capped or approaching threshold
    LOW:       'low',       // below max freq; thermal cause unconfirmed
    IDLE:      'idle',      // component inactive
    UNKNOWN:   'unknown',   // no usable sysfs data
});

// Ordered worst-to-best; CONF_SEVERITY.find() picks the worst level present.
export const CONF_SEVERITY = [
    Confidence.CONFIRMED,
    Confidence.HIGH,
    Confidence.MEDIUM,
    Confidence.LOW,
    Confidence.UNKNOWN,
    Confidence.IDLE,
];

export const CONF_BADGE = {
    [Confidence.CONFIRMED]: '████ CONFIRMED',
    [Confidence.HIGH]:      '███░ HIGH',
    [Confidence.MEDIUM]:    '██░░ MEDIUM',
    [Confidence.LOW]:       '█░░░ LOW',
    [Confidence.IDLE]:      '░░░░ IDLE',
    [Confidence.UNKNOWN]:   '░░░░ —',
};

// CSS class names applied to the panel label (see stylesheet.css).
// IDLE and UNKNOWN use 'color: inherit' in the stylesheet so the
// "all clear" state adopts the panel's own foreground colour.
export const CONF_STYLE_CLASS = {
    [Confidence.CONFIRMED]: 'ttm-confirmed',
    [Confidence.HIGH]:      'ttm-high',
    [Confidence.MEDIUM]:    'ttm-medium',
    [Confidence.LOW]:       'ttm-low',
    [Confidence.IDLE]:      'ttm-idle',
    [Confidence.UNKNOWN]:   'ttm-unknown',
};
