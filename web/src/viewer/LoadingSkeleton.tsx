import './loading-skeleton.css';

const CARD_WIDTHS = [68, 54, 76, 60, 72, 58];
const REQUIREMENT_LINES = [[94, 100, 86, 96, 64], [100, 88, 72]];
const OUTPUT_LINES = [[100, 96, 88, 100, 72], [92, 100, 84, 96, 58]];

function TextLines({ paragraphs }: { paragraphs: number[][] }) {
  return <div className="loading-skeleton-paragraphs">{paragraphs.map((lines, paragraph) =>
    <div className="loading-skeleton-paragraph" key={paragraph}>{lines.map((width, line) =>
      <span className="loading-skeleton-fill loading-skeleton-line" style={{ width: `${width}%` }} key={line} />,
    )}</div>,
  )}</div>;
}

export function LoadingSkeleton({ label, variant = 'cards' }: { label: string; variant?: 'cards' | 'conversation' }) {
  return <div className={`loading-skeleton loading-skeleton--${variant}`}>
    <span className="loading-skeleton-status" role="status" aria-live="polite" aria-atomic="true">{label}</span>
    {variant === 'conversation' ? <div className="loading-skeleton-visual loading-skeleton-conversation" aria-hidden="true">
      <div className="loading-skeleton-round"><span className="loading-skeleton-fill" /></div>
      <div className="loading-skeleton-detail-grid">
        <div className="loading-skeleton-panel">
          <span className="loading-skeleton-fill loading-skeleton-panel-title" />
          <TextLines paragraphs={REQUIREMENT_LINES} />
        </div>
        <div className="loading-skeleton-panel">
          <span className="loading-skeleton-fill loading-skeleton-panel-title" />
          <TextLines paragraphs={OUTPUT_LINES} />
        </div>
      </div>
    </div> : <div className="loading-skeleton-visual loading-skeleton-cards" aria-hidden="true">
      {CARD_WIDTHS.map((width, index) => <div className="loading-skeleton-card" key={index}>
        <span className="loading-skeleton-fill loading-skeleton-card-title" style={{ width: `${width}%` }} />
        <span className="loading-skeleton-fill loading-skeleton-card-meta" />
      </div>)}
    </div>}
  </div>;
}
