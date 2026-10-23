import type { JsonSchemaObject } from '@contract';
import { useId, useMemo } from 'react';
import { schemaFields } from '@/lib/schema';

// The fields a tool takes, from its input schema: the name, the type, whether it is required, the
// description, and what the value must satisfy.
export function SchemaFields({ schema }: { schema: JsonSchemaObject }) {
  const headingId = useId();
  const fields = useMemo(() => schemaFields(schema), [schema]);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h3 id={headingId} className="font-heading text-base font-medium">
        Input fields
      </h3>
      {fields.length === 0 ? (
        <p className="text-muted-foreground">This tool takes no arguments.</p>
      ) : (
        <ul aria-labelledby={headingId} className="flex flex-col divide-y rounded-lg border">
          {fields.map((field) => (
            <li key={field.name} className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <code className="font-mono font-medium break-all">{field.name}</code>
                <span className="font-mono text-xs text-muted-foreground">{field.type}</span>
                <span
                  className={
                    field.required
                      ? 'text-xs font-medium text-amber-800 dark:text-amber-300'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {field.required ? 'required' : 'optional'}
                </span>
              </p>
              {field.description === undefined ? null : (
                <p className="text-muted-foreground whitespace-pre-line">{field.description}</p>
              )}
              {field.constraints.length === 0 ? null : (
                <ul aria-label={`Constraints of ${field.name}`} className="flex flex-wrap gap-1.5">
                  {field.constraints.map((constraint, index) => (
                    <li
                      key={index}
                      className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere"
                    >
                      {constraint}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
