import pc from 'picocolors';
import { PACKAGE_NAME } from '../version.js';

export interface BannerInfo {
  version: string;
  transport: string;
  // Where an HTTP client connects. It must never hold the token, since the banner ends up in logs.
  endpoint?: string;
  // Where the dashboard page is. It must never hold the token either.
  dashboard?: string;
  // TradingView's debug port.
  cdp: string;
}

// For stderr: in stdio mode stdout carries the protocol. The caller decides about color from the
// stream it writes to, which picocolors' own guess cannot know (it looks at stdout).
export function renderBanner(info: BannerInfo, options: { color?: boolean } = {}): string {
  const c = pc.createColors(options.color ?? pc.isColorSupported);
  const rows: [label: string, value: string][] = [['transport', info.transport]];
  if (info.endpoint !== undefined) {
    rows.push(['endpoint', info.endpoint]);
  }
  if (info.dashboard !== undefined) {
    rows.push(['dashboard', info.dashboard]);
  }
  rows.push(['cdp', info.cdp]);
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return [
    `${c.bold(c.cyan(PACKAGE_NAME))} ${c.dim(`v${info.version}`)}`,
    ...rows.map(([label, value]) => `  ${c.dim(label.padEnd(width))}${value}`),
    '',
  ].join('\n');
}
