import { Card, EmptyState } from '../components/ui';
import { Icon } from '../components/icons';

/** Stands in for a route whose module has not been ported across yet. */
export function Placeholder({ name }: { name: string }) {
  return (
    <Card>
      <EmptyState icon={<Icon n="hourglass" size="lg" />} msg={name + ' has not been ported from the prototype yet.'} />
    </Card>
  );
}
