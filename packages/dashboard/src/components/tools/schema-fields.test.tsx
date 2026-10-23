import { render, screen, within } from '@testing-library/react';
import { SchemaFields } from './schema-fields';

function field(name: string): HTMLElement {
  const list = screen.getByRole('list', { name: 'Input fields' });
  const item = within(list).getByText(name, { selector: 'code' }).closest('li');
  if (item === null) {
    throw new Error(`No input field ${name}`);
  }
  return item;
}

test('a field shows its name, type and whether it is required, with a description and constraints only when it has them', () => {
  render(
    <SchemaFields
      schema={{
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[0-9]+$', description: 'The id, from a list.' },
          flag: { type: 'boolean' },
        },
        required: ['flag'],
      }}
    />,
  );
  expect(field('id')).toHaveTextContent('idstringoptionalThe id, from a list.pattern ^[0-9]+$');
  expect(within(field('id')).getByRole('list', { name: 'Constraints of id' })).toHaveTextContent(
    'pattern ^[0-9]+$',
  );
  expect(field('flag')).toHaveTextContent(/^flagbooleanrequired$/);
  expect(within(field('flag')).queryByRole('list')).not.toBeInTheDocument();
  expect(field('flag').querySelectorAll('p')).toHaveLength(1);
});
