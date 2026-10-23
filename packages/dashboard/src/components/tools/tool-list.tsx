import type { DashboardDomain, DashboardTool } from '@contract';
import { SearchIcon, XIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

// What a tool does to TradingView, from its annotations: each tool is one of the three.
export type ToolEffect = 'read-only' | 'changes' | 'destructive';

export function toolEffect(tool: DashboardTool): ToolEffect {
  if (tool.annotations.readOnlyHint) {
    return 'read-only';
  }
  return tool.annotations.destructiveHint ? 'destructive' : 'changes';
}

const EFFECT_OPTIONS: { value: ToolFilter['effect']; label: string }[] = [
  { value: 'all', label: 'Any effect' },
  { value: 'read-only', label: 'Read-only' },
  { value: 'changes', label: 'Changes' },
  { value: 'destructive', label: 'Destructive' },
];

export interface ToolFilter {
  // Words that the name, the title or the description must each hold.
  q: string;
  domain: 'all' | DashboardDomain;
  // Only the tools of the core profile, of the readonly profile, or of both.
  core: boolean;
  readonly: boolean;
  effect: 'all' | ToolEffect;
}

export const NO_FILTER: ToolFilter = {
  q: '',
  domain: 'all',
  core: false,
  readonly: false,
  effect: 'all',
};

// The tools that pass `filter`, in the order the server lists them.
export function filterTools(tools: readonly DashboardTool[], filter: ToolFilter): DashboardTool[] {
  const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  return tools.filter((tool) => {
    if (filter.domain !== 'all' && tool.domain !== filter.domain) {
      return false;
    }
    if (filter.core && !tool.profiles.includes('core')) {
      return false;
    }
    if (filter.readonly && !tool.profiles.includes('readonly')) {
      return false;
    }
    if (filter.effect !== 'all' && toolEffect(tool) !== filter.effect) {
      return false;
    }
    const text = `${tool.name}\n${tool.title}\n${tool.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

function ToolItem({ tool, selected }: { tool: DashboardTool; selected: boolean }) {
  const effect = toolEffect(tool);
  return (
    <li>
      <Link
        href={`/tools/${encodeURIComponent(tool.name)}`}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'flex flex-col gap-1 rounded-lg px-3 py-2 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
          selected && 'bg-muted',
        )}
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <code className="font-mono text-sm font-medium break-all">{tool.name}</code>
          {effect === 'read-only' ? <Badge variant="secondary">read-only</Badge> : null}
          {effect === 'destructive' ? <Badge variant="destructive">destructive</Badge> : null}
          {tool.core ? <Badge variant="outline">core</Badge> : null}
        </span>
        <span className="text-sm text-muted-foreground">{tool.title}</span>
      </Link>
    </li>
  );
}

interface ToolListProps {
  tools: readonly DashboardTool[];
  // The name of the tool shown beside the list.
  selected?: string | undefined;
  className?: string;
}

// The tools the server offers, to search and filter, each a link to its page.
export function ToolList({ tools, selected, className }: ToolListProps) {
  const searchId = useId();
  const domainId = useId();
  const effectId = useId();
  const coreId = useId();
  const readonlyId = useId();
  const [filter, setFilter] = useState(NO_FILTER);
  const change = (next: Partial<ToolFilter>) => {
    setFilter((current) => ({ ...current, ...next }));
  };
  // The domains of the tools offered, in the order the server lists them.
  const domains = useMemo(() => [...new Set(tools.map((tool) => tool.domain))], [tools]);
  const shown = useMemo(() => filterTools(tools, filter), [tools, filter]);
  const filtered =
    filter.q !== '' ||
    filter.domain !== 'all' ||
    filter.core ||
    filter.readonly ||
    filter.effect !== 'all';

  return (
    <div className={cn('flex min-w-0 flex-col gap-4', className)}>
      <div role="search" aria-label="Filter the tools" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={searchId}>Search tools</Label>
          <div className="relative">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              value={filter.q}
              placeholder="Name, title or description"
              autoComplete="off"
              spellCheck={false}
              className="pl-8"
              onChange={(event) => {
                change({ q: event.target.value });
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={domainId}>Domain</Label>
            <Select
              value={filter.domain}
              onValueChange={(domain) => {
                change({ domain: domain as ToolFilter['domain'] });
              }}
            >
              <SelectTrigger id={domainId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All domains</SelectItem>
                {domains.map((domain) => (
                  <SelectItem key={domain} value={domain}>
                    {domain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={effectId}>Effect</Label>
            <Select
              value={filter.effect}
              onValueChange={(effect) => {
                change({ effect: effect as ToolFilter['effect'] });
              }}
            >
              <SelectTrigger id={effectId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFECT_OPTIONS.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-2">
            <Switch
              id={coreId}
              checked={filter.core}
              onCheckedChange={(core) => {
                change({ core });
              }}
            />
            <Label htmlFor={coreId}>core profile</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={readonlyId}
              checked={filter.readonly}
              onCheckedChange={(readonly) => {
                change({ readonly });
              }}
            />
            <Label htmlFor={readonlyId}>readonly profile</Label>
          </div>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setFilter(NO_FILTER);
              }}
            >
              <XIcon aria-hidden />
              Reset filters
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <p role="status" className="text-sm text-muted-foreground">
          {shown.length === tools.length
            ? `${String(tools.length)} tools`
            : `${String(shown.length)} of ${String(tools.length)} tools`}
        </p>
        {shown.length === 0 ? (
          <p className="text-muted-foreground">No tools match the filters.</p>
        ) : (
          <ul aria-label="Tools" className="flex flex-col gap-0.5">
            {shown.map((tool) => (
              <ToolItem key={tool.name} tool={tool} selected={tool.name === selected} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
