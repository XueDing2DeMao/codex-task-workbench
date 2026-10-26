import { useState } from 'react';
import type { Handoff } from '../../../shared/contracts.ts';
import { download, labels, shortId } from '../model.ts';
import { Dialog, ErrorNotice } from './Ui.tsx';
import { Icon } from './Icon.tsx';

export function HandoffDialog({ handoff, onClose, onImport }: { handoff: Handoff; onClose: () => void; onImport?: () => void }) {
  const [copied, setCopied] = useState(false); const [error, setError] = useState('');
  return <Dialog title={`${labels[handoff.purpose]}已生成`} description="下载后在 Codex 中使用。网页不会自动向对话发送指令或启动模型。" onClose={onClose} wide>
    <div className="handoff-meta"><span>交接包 <code>{shortId(handoff.id)}</code></span><span>{handoff.sourceIds.length} 条关联来源</span>{handoff.revisionId ? <span>已冻结任务版本</span> : null}</div>
    <ol className="handoff-steps"><li>下载 JSON 文件，在 Codex 对话中提供这个文件。</li><li>复制下方说明，作为本次整理或执行的要求。</li><li>将 Codex 返回的结构化草稿或执行回执导入工作台。</li></ol>
    <pre className="source-text handoff-instruction">{handoff.instruction}</pre><ErrorNotice message={error} />
    {onImport ? <div className="notice notice-info">Codex 返回整理结果后，可在这里导入并创建任务草稿。<button className="text-button" onClick={onImport}>导入整理结果并建卡<Icon name="arrow" size={15} /></button></div> : null}
    <div className="dialog-footer"><button className="button" onClick={() => { void navigator.clipboard.writeText(handoff.instruction).then(() => setCopied(true)).catch(() => setError('无法写入剪贴板，可直接选中上方说明复制。')); }}><Icon name={copied ? 'check' : 'copy'} />{copied ? '已复制说明' : '复制说明'}</button><button className="button button-primary" onClick={() => download(`${handoff.purpose}-${handoff.id}.json`, JSON.stringify(handoff, null, 2))}><Icon name="download" />下载交接包</button></div>
  </Dialog>;
}
