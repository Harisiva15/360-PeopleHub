import { Card, EmptyState } from '../components/ui';

/** Stands in for a route whose module has not been ported across yet. */
export function Placeholder({ name }: { name: string }) {
  return (
    <Card>
      <EmptyState icon="⧗" msg={name + ' has not been ported from the prototype yet.'} />
    </Card>
  );
}
