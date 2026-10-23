import { SearchIcon, XIcon } from 'lucide-react';
import { useCallback, useId, useMemo } from 'react';
import { useSearchParams } from 'wouter';
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
import {
  ALL,
  filterFromSearch,
  ORIGINS,
  searchWithFilter,
  type CallFilter,
} from '@/lib/call-filter';

const STATUS_OPTIONS: { value: CallFilter['status']; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'ok', label: 'OK' },
  { value: 'error', label: 'Error' },
];

// The filter of the live log, from the address, and how to change it. A change replaces the
// address rather than add to the history, so that Back leaves the page instead of undoing a
// keystroke.
export function useCallFilter(): [CallFilter, (change: Partial<CallFilter>) => void] {
  const [search, setSearch] = useSearchParams();
  const filter = useMemo(() => filterFromSearch(search), [search]);
  const change = useCallback(
    (next: Partial<CallFilter>) => {
      setSearch((current) => searchWithFilter(current, next), { replace: true });
    },
    [setSearch],
  );
  return [filter, change];
}

interface CallFiltersProps {
  filter: CallFilter;
  onChange: (change: Partial<CallFilter>) => void;
}

// A search on the tool name, and a choice of origin and of status.
export function CallFilters({ filter, onChange }: CallFiltersProps) {
  const searchId = useId();
  const originId = useId();
  const statusId = useId();
  const filtered = filter.q !== '' || filter.origin !== ALL.origin || filter.status !== ALL.status;
  return (
    <div role="search" aria-label="Filter the calls" className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-48 flex-1 flex-col gap-1.5">
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
            placeholder="A part of the tool name"
            autoComplete="off"
            spellCheck={false}
            className="pl-8"
            onChange={(event) => {
              onChange({ q: event.target.value });
            }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={originId}>Origin</Label>
        <Select
          value={filter.origin}
          onValueChange={(origin) => {
            onChange({ origin: origin as CallFilter['origin'] });
          }}
        >
          <SelectTrigger id={originId} className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All origins</SelectItem>
            {ORIGINS.map((origin) => (
              <SelectItem key={origin} value={origin}>
                {origin}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={statusId}>Status</Label>
        <Select
          value={filter.status}
          onValueChange={(status) => {
            onChange({ status: status as CallFilter['status'] });
          }}
        >
          <SelectTrigger id={statusId} className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {filtered ? (
        <Button
          variant="ghost"
          onClick={() => {
            onChange(ALL);
          }}
        >
          <XIcon aria-hidden />
          Reset filters
        </Button>
      ) : null}
    </div>
  );
}
