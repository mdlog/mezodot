import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/**
 * A select whose options carry a logo, a detail line and a right-aligned figure, which a native <select> would
 * flatten to text. It follows the WAI-ARIA select-only combobox pattern: focus stays on the trigger, arrow keys move
 * the highlighted option (aria-activedescendant), Enter or Space picks it, Escape or leaving the trigger closes the list.
 */

export type DropdownOption<T extends string | number> = {
  value: T;
  icon: ReactNode;
  label: ReactNode;
  /** Second line under the label. */
  detail?: ReactNode;
  /** Right-aligned figure, e.g. a price. */
  meta?: ReactNode;
};

export type ListboxKeyResult = { type: 'move'; index: number } | { type: 'select'; index: number } | { type: 'close' } | null;

/** Keys that open a closed dropdown, as on a native select. */
export const opensOn = (key: string): boolean => key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ';

/** What a key does in the open list of `count` options while option `active` is highlighted; null when nothing. */
export function listboxKey(key: string, active: number, count: number): ListboxKeyResult {
  switch (key) {
    case 'ArrowDown':
      return { type: 'move', index: Math.min(active + 1, count - 1) };
    case 'ArrowUp':
      return { type: 'move', index: Math.max(active - 1, 0) };
    case 'Home':
      return { type: 'move', index: 0 };
    case 'End':
      return { type: 'move', index: count - 1 };
    case 'Enter':
    case ' ':
      return { type: 'select', index: active };
    case 'Escape':
      return { type: 'close' };
    default:
      return null;
  }
}

/** The one place option ids are made, so the trigger's aria-activedescendant always names a rendered option. */
const optionId = (listId: string, index: number) => `${listId}-${index}`;

function OptionBody<T extends string | number>({ option }: { option: DropdownOption<T> }) {
  return (
    <>
      {option.icon}
      <span className="dropdown-text">
        <b>{option.label}</b>
        {option.detail !== undefined && <small>{option.detail}</small>}
      </span>
      {option.meta !== undefined && <span className="dropdown-meta">{option.meta}</span>}
    </>
  );
}

export function Dropdown<T extends string | number>({
  labelId,
  options,
  value,
  onChange,
  className,
}: {
  /** Id of the visible field label, which names the control. */
  labelId: string;
  options: DropdownOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = options[selectedIndex];

  // A tap outside closes the list on touch screens as well, where it can leave focus on the trigger.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const show = () => {
    setActive(Math.max(selectedIndex, 0));
    setOpen(true);
  };
  const pick = (index: number) => {
    setOpen(false);
    const option = options[index];
    if (option && option.value !== value) onChange(option.value);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (opensOn(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    const action = listboxKey(e.key, active, options.length);
    if (!action) return;
    e.preventDefault();
    if (action.type === 'move') setActive(action.index);
    else if (action.type === 'select') pick(action.index);
    else setOpen(false);
  };

  return (
    <div className={className ? `dropdown ${className}` : 'dropdown'} ref={rootRef}>
      <div
        role="combobox"
        tabIndex={0}
        className={open ? 'dropdown-trigger is-open' : 'dropdown-trigger'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={labelId}
        aria-activedescendant={open ? optionId(listId, active) : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {selected && <OptionBody option={selected} />}
        <ChevronDown size={16} className="dropdown-chevron" aria-hidden />
      </div>
      <DropdownList id={listId} labelId={labelId} options={options} value={value} active={active} hidden={!open} onPick={pick} onActive={setActive} />
    </div>
  );
}

/** The options. They are not focusable: the trigger keeps focus and points at the active one. */
export function DropdownList<T extends string | number>({
  id,
  labelId,
  options,
  value,
  active,
  hidden,
  onPick,
  onActive,
}: {
  id: string;
  labelId: string;
  options: DropdownOption<T>[];
  value: T;
  /** The option keyboard and pointer are on, highlighted; picked with Enter, Space or a click. */
  active: number;
  hidden?: boolean;
  onPick: (index: number) => void;
  onActive: (index: number) => void;
}) {
  return (
    <ul id={id} role="listbox" className="dropdown-list" aria-labelledby={labelId} hidden={hidden}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <li
            key={o.value}
            id={optionId(id, i)}
            role="option"
            aria-selected={selected}
            className={`dropdown-option${i === active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
            // Keeps focus on the trigger, so the click lands here instead of a blur closing the list first.
            onMouseDown={(e) => e.preventDefault()}
            // Movement, not mere entry: a list opening under a resting pointer keeps the keyboard's highlight.
            onMouseMove={() => onActive(i)}
            onClick={() => onPick(i)}
          >
            <OptionBody option={o} />
            {selected && <Check size={16} className="dropdown-check" aria-hidden />}
          </li>
        );
      })}
    </ul>
  );
}
