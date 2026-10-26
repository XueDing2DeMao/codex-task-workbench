import { Fragment } from 'react';
import type { ReactNode } from 'react';

// 只渲染文字与受限 Markdown，不执行历史中的 HTML 或本地命令。
function inline(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^\)\n]+\))/g);
  return tokens.map((token, index) => {
    if (token.startsWith('**') && token.endsWith('**')) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith('`') && token.endsWith('`')) return <code key={index}>{token.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
    if (link) {
      const target = link[2].trim().replace(/^<|>$/g, '');
      if (/^https?:\/\//i.test(target)) return <a key={index} href={target} target="_blank" rel="noreferrer">{link[1]}</a>;
      return <Fragment key={index}>{link[1]} <code>{target}</code></Fragment>;
    }
    return token;
  });
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}
function isTableAt(lines: string[], index: number): boolean {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return false;
  const cells = tableCells(lines[index + 1]);
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

export function Content({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const blockStart = i;
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (isTableAt(lines, i)) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(tableCells(lines[i++]));
      blocks.push(<div className="content-table-wrap" key={blockStart}><table><thead><tr>{headers.map((header, index) => <th key={index} scope="col">{inline(header)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, column) => <td key={column}>{inline(row[column] ?? '')}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(<pre key={blockStart}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h3 key={blockStart}>{inline(line.replace(/^#{1,6}\s+/, ''))}</h3>);
      i++; continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { i++; continue; }
    const list = /^\s*(?:[-*+] |\d+[.)] )/.test(line);
    if (list) {
      const ordered = /^\s*\d+[.)] /.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*(?:[-*+] |\d+[.)] )/.test(lines[i])) items.push(lines[i++].replace(/^\s*(?:[-*+] |\d+[.)] )/, ''));
      const children = items.map((item, index) => <li key={index}>{inline(item)}</li>);
      blocks.push(ordered ? <ol key={blockStart}>{children}</ol> : <ul key={blockStart}>{children}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push(<blockquote key={blockStart}>{inline(line.replace(/^>\s?/, ''))}</blockquote>);
      i++; continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isTableAt(lines, i) && !/^\s*(?:```|#{1,6}\s|[-*+] |\d+[.)] |>)/.test(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={blockStart}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="readable-content">{blocks}</div>;
}
