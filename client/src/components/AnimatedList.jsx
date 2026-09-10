import { useRef, useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import './AnimatedList.css';

/*
 * ── NHA integration seam: the in-view detector ────────────────────────────
 *
 * The vendor file used `useInView` from motion/react. In this app that hook
 * never reports true — measured on the dev server AND a production build,
 * while a plain IntersectionObserver on the very same node reported
 * isIntersecting with ratio 1. Root cause inside motion was not identified;
 * the failure mode is what matters, because AnimatedItem gates OPACITY on it
 * and a transcript that renders blank is not a survivable trade.
 *
 * So the detector is replaced and nothing else is. motion.div, `initial`,
 * `animate`, the 0.2s transition and the 0.7 -> 1 scale are the vendor's,
 * untouched; only the boolean feeding them is computed here.
 *
 * ROOT. The observer watches the nearest scrollable ancestor rather than the
 * window, which is what makes this work inside the playground at all: the
 * transcript scrolls inside .msgs, so "on screen" is a question about that box,
 * not about the viewport. Resolved by walking up from the node itself, so no
 * selector is hard-coded here and <AnimatedList>'s own .scroll-list works the
 * same way.
 */
function findScrollParent(node) {
  let el = node?.parentElement;
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') return el;
    el = el.parentElement;
  }
  return null; // null root = the viewport, which is IntersectionObserver's default
}

function useInViewport(ref, { amount = 0.5, once = false } = {}) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') { setInView(true); return undefined; }

    /*
     * "some" means any pixel counts. That is the setting a transcript needs:
     * a reply taller than the scroller can never satisfy a 0.5 ratio, so a
     * numeric threshold would leave long answers permanently hidden.
     */
    const threshold = amount === 'some' ? 0 : amount === 'all' ? 0.999 : amount;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) {
          // Leaving re-arms the animation, which is what makes scrolling UP
          // replay it as well as scrolling down.
          setInView(false);
        }
      },
      { root: findScrollParent(node), threshold },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [ref, amount, once]);
  return inView;
}

export const AnimatedItem = ({
  children,
  delay = 0,
  index,
  onMouseEnter,
  onClick,
  /*
   * Every default below is the value the vendor hard-coded, so <AnimatedList>
   * renders exactly as it always did. The transcript overrides them:
   *
   *  amount "some"  — see the note above.
   *  once  false    — the point of the effect. Rows animate every time they
   *                   re-enter, so scrolling either way replays it.
   *  cursor / margin — a transcript is selectable text, not a menu, and .msgs
   *                   already owns the gap between rows.
   */
  amount = 0.5,
  once = false,
  className,
  style,
}) => {
  const ref = useRef(null);
  const inView = useInViewport(ref, { amount, once });
  return (
    <motion.div
      ref={ref}
      data-index={index}
      className={className}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      initial={{ scale: 0.7, opacity: 0 }}
      animate={inView ? { scale: 1, opacity: 1 } : { scale: 0.7, opacity: 0 }}
      transition={{ duration: 0.2, delay }}
      style={{ marginBottom: '1rem', cursor: 'pointer', ...style }}
    >
      {children}
    </motion.div>
  );
};

const AnimatedList = ({
  items = [
    'Item 1',
    'Item 2',
    'Item 3',
    'Item 4',
    'Item 5',
    'Item 6',
    'Item 7',
    'Item 8',
    'Item 9',
    'Item 10',
    'Item 11',
    'Item 12',
    'Item 13',
    'Item 14',
    'Item 15'
  ],
  onItemSelect,
  showGradients = true,
  enableArrowNavigation = true,
  className = '',
  itemClassName = '',
  displayScrollbar = true,
  initialSelectedIndex = -1
}) => {
  const listRef = useRef(null);
  const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [topGradientOpacity, setTopGradientOpacity] = useState(0);
  const [bottomGradientOpacity, setBottomGradientOpacity] = useState(1);

  const handleItemMouseEnter = useCallback(index => {
    setSelectedIndex(index);
  }, []);

  const handleItemClick = useCallback(
    (item, index) => {
      setSelectedIndex(index);
      if (onItemSelect) {
        onItemSelect(item, index);
      }
    },
    [onItemSelect]
  );

  const handleScroll = useCallback(e => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    setTopGradientOpacity(Math.min(scrollTop / 50, 1));
    const bottomDistance = scrollHeight - (scrollTop + clientHeight);
    setBottomGradientOpacity(scrollHeight <= clientHeight ? 0 : Math.min(bottomDistance / 50, 1));
  }, []);

  useEffect(() => {
    if (!enableArrowNavigation) return;
    const handleKeyDown = e => {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        setKeyboardNav(true);
        setSelectedIndex(prev => Math.min(prev + 1, items.length - 1));
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        setKeyboardNav(true);
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        if (selectedIndex >= 0 && selectedIndex < items.length) {
          e.preventDefault();
          if (onItemSelect) {
            onItemSelect(items[selectedIndex], selectedIndex);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, selectedIndex, onItemSelect, enableArrowNavigation]);

  useEffect(() => {
    if (!keyboardNav || selectedIndex < 0 || !listRef.current) return;
    const container = listRef.current;
    const selectedItem = container.querySelector(`[data-index="${selectedIndex}"]`);
    if (selectedItem) {
      const extraMargin = 50;
      const containerScrollTop = container.scrollTop;
      const containerHeight = container.clientHeight;
      const itemTop = selectedItem.offsetTop;
      const itemBottom = itemTop + selectedItem.offsetHeight;
      if (itemTop < containerScrollTop + extraMargin) {
        container.scrollTo({ top: itemTop - extraMargin, behavior: 'smooth' });
      } else if (itemBottom > containerScrollTop + containerHeight - extraMargin) {
        container.scrollTo({
          top: itemBottom - containerHeight + extraMargin,
          behavior: 'smooth'
        });
      }
    }
    setKeyboardNav(false);
  }, [selectedIndex, keyboardNav]);

  return (
    <div className={`scroll-list-container ${className}`}>
      <div ref={listRef} className={`scroll-list ${!displayScrollbar ? 'no-scrollbar' : ''}`} onScroll={handleScroll}>
        {items.map((item, index) => (
          <AnimatedItem
            key={index}
            delay={0.1}
            index={index}
            onMouseEnter={() => handleItemMouseEnter(index)}
            onClick={() => handleItemClick(item, index)}
          >
            <div className={`item ${selectedIndex === index ? 'selected' : ''} ${itemClassName}`}>
              <p className="item-text">{item}</p>
            </div>
          </AnimatedItem>
        ))}
      </div>
      {showGradients && (
        <>
          <div className="top-gradient" style={{ opacity: topGradientOpacity }}></div>
          <div className="bottom-gradient" style={{ opacity: bottomGradientOpacity }}></div>
        </>
      )}
    </div>
  );
};

export default AnimatedList;
