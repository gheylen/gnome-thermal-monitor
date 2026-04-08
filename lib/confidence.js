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
    Confidence.IDLE,
    Confidence.UNKNOWN,
];

export const CONF_BADGE = {
    [Confidence.CONFIRMED]: '████ CONFIRMED',
    [Confidence.HIGH]:      '███░ HIGH',
    [Confidence.MEDIUM]:    '██░░ MEDIUM',
    [Confidence.LOW]:       '█░░░ LOW',
    [Confidence.IDLE]:      '░░░░ IDLE',
    [Confidence.UNKNOWN]:   '░░░░ —',
};

export const CONF_COLOR = {
    [Confidence.CONFIRMED]: '#ff4444',
    [Confidence.HIGH]:      '#ff4444',
    [Confidence.MEDIUM]:    '#f57900',
    [Confidence.LOW]:       '#73d216',
    [Confidence.IDLE]:      '#aaaaaa',
    [Confidence.UNKNOWN]:   '#aaaaaa',
};
