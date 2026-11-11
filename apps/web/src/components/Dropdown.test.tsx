import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dropdown, DropdownList, listboxKey, opensOn, type DropdownOption } from './Dropdown';

/** The dropdown's contract: which keys open and move it, what the trigger shows, how the list marks options. */

const CHAINS: DropdownOption<string>[] = [
  { value: 'base-sepolia', icon: null, label: 'Base Sepolia', detail: 'Wormhole chain 10004' },
  { value: 'eth-sepolia', icon: null, label: 'Ethereum Sepolia', detail: 'Wormhole chain 10002' },
];

/** The combobox element, opening tag through its closing tag (it holds no nested div). */
const combobox = (html: string) => html.match(/<div[^>]*role="combobox"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? '';
/** The <li> with this id, opening tag through closing tag. */
const optionById = (html: string, id: string) => html.match(new RegExp(`<li[^>]*id="${id}"[^>]*>[\\s\\S]*?</li>`))?.[0] ?? '';

describe('opensOn', () => {
  it.each([
    ['ArrowDown', true],
    ['ArrowUp', true],
    ['Enter', true],
    [' ', true],
    ['Escape', false],
    ['Tab', false],
    ['a', false],
  ])('%j opens a closed dropdown: %s', (key, want) => {
    expect(opensOn(key)).toBe(want);
  });
});

describe('listboxKey', () => {
  it.each([
    ['ArrowDown', 0, { type: 'move', index: 1 }],
    ['ArrowDown', 2, { type: 'move', index: 2 }], // stays on the last option, no wrap-around
    ['ArrowUp', 2, { type: 'move', index: 1 }],
    ['ArrowUp', 0, { type: 'move', index: 0 }], // stays on the first option
    ['Home', 2, { type: 'move', index: 0 }],
    ['End', 0, { type: 'move', index: 2 }],
    ['Enter', 1, { type: 'select', index: 1 }],
    [' ', 2, { type: 'select', index: 2 }],
    ['Escape', 1, { type: 'close' }],
    ['a', 1, null],
  ])('%j from option %i of 3', (key, active, want) => {
    expect(listboxKey(key, active, 3)).toEqual(want);
  });
});

describe('Dropdown', () => {
  const html = renderToStaticMarkup(<Dropdown labelId="source" options={CHAINS} value="eth-sepolia" onChange={() => {}} />);
  const trigger = combobox(html);

  it('shows the selected option on its trigger, not the first one', () => {
    expect(trigger).toContain('Ethereum Sepolia');
    expect(trigger).toContain('Wormhole chain 10002');
    expect(trigger).not.toContain('Base Sepolia');
  });

  it('is a focusable, collapsed listbox popup named by the field label', () => {
    expect(trigger).toContain('tabindex="0"');
    expect(trigger).toContain('aria-haspopup="listbox"');
    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toContain('aria-labelledby="source"');
  });
});

describe('DropdownList', () => {
  const html = renderToStaticMarkup(
    <DropdownList id="list" labelId="source" options={CHAINS} value="eth-sepolia" active={0} onPick={() => {}} onActive={() => {}} />,
  );

  it('marks only the selected option as selected', () => {
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(optionById(html, 'list-1')).toContain('aria-selected="true"');
    expect(optionById(html, 'list-1')).toContain('Ethereum Sepolia');
    expect(optionById(html, 'list-0')).toContain('aria-selected="false"');
  });

  it('highlights the keyboard-active option, which need not be the selected one', () => {
    expect(optionById(html, 'list-0')).toMatch(/class="[^"]*\bis-active\b/);
    expect(optionById(html, 'list-1')).not.toMatch(/class="[^"]*\bis-active\b/);
  });
});
