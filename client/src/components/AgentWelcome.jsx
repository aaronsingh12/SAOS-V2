import { memo, useEffect, useState } from 'react';
import StrokeText from './StrokeText.jsx';

/*
 * THE NEW-CHAT STATE.
 *
 * Content on the waves, not a card on the waves. There is no border, no
 * panel and no surface here — the playground background IS the background, and
 * everything below is centred type sitting directly on it.
 *
 * PRESENTATION ONLY, and now content-free: a mark, a cycling headline and one
 * sentence. It takes no props, holds no session state and calls nothing —
 * there is no longer any path from this component into a turn.
 */

/*
 * Phrases, deliberately about work this product actually does on a ServiceNow
 * instance — no "what can I help you with", no "unlock your potential".
 *
 * They are also all 23-25 characters. StrokeText scales its SVG to the width
 * of its container, so a short phrase would render visibly LARGER than a long
 * one; keeping the lengths close is what stops the headline from jumping size
 * every time it cycles.
 */
const HEADLINES = [
  'Build ServiceNow features',
  'Design powerful workflows',
  'Automate ServiceNow tasks',
  'Create and manage flows',
  'Explore your ServiceNow',
];

/*
 * ~2.6s of that is the draw-and-fill itself (drawDuration 1.6 + fillDelay 0.2
 * + the wipe), which leaves roughly three seconds of the finished phrase to
 * read before the next one starts.
 */
const CYCLE_MS = 5500;

/*
 * THE ONLY THING THAT CYCLES.
 *
 * The interval and the index live in HERE, not in the parent, so a phrase
 * change re-renders this component and nothing else — the description below it
 * and the mark above it are never touched by the timer. memo() holds
 * that line from the other direction too: AgentChat re-renders on plenty of
 * things, and none of them should restart the animation.
 *
 * The `key` is what replays it. StrokeText draws on mount, so giving it a new
 * key per phrase remounts it and runs the stroke animation again — which is
 * the transition between phrases rather than a crossfade bolted on top.
 */
const CyclingHeadline = memo(function CyclingHeadline() {
  const [i, setI] = useState(0);

  useEffect(() => {
    // Forever, by construction: modulo wraps and nothing clears it but unmount.
    const id = setInterval(() => setI((n) => (n + 1) % HEADLINES.length), CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  const text = HEADLINES[i];
  return (
    <StrokeText
      key={text}
      text={text}
      /* The app's own accent draws the outline; the app's own text colour
         fills it. No new colours enter the palette here. */
      strokeColor="#57b57c"
      fillColor="#e7e3da"
      strokeWidth={1.2}
      fontSize={72}
      fontWeight={700}
      letterSpacing={-1}
      drawDuration={1.6}
      fillDelay={0.2}
      className="welcome-headline"
    />
  );
});

function AgentWelcome() {
  return (
    <div className="welcome">
      {/* The identity, kept small on purpose: the same mark the browser tab
          and the sidebar wordmark already use, at a size that reads as a
          signature rather than a logo. The headline is the focus. */}
      <img className="welcome-mark" src="/favicon.svg" alt="" width="34" height="34" aria-hidden="true" />

      <CyclingHeadline />

      {/* STATIC. It says what the product is once, and the cycling headline
          above says what it does. Rewriting this every five seconds too would
          leave nothing on screen for the eye to rest on. */}
      <p className="welcome-sub">
        Your AI assistant for building, exploring, and managing ServiceNow.
      </p>

    </div>
  );
}

export default memo(AgentWelcome);
