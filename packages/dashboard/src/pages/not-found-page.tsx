import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { PageHeader } from './page-header';

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-start gap-4">
      <PageHeader title="Page not found" description="The dashboard has no page at this address." />
      <Button asChild variant="outline">
        <Link href="/">Go to the status page</Link>
      </Button>
    </div>
  );
}
