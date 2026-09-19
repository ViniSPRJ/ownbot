# Streaming scroll regression

Exercise `ChatTranscript` in a browser with enough user/assistant turns to overflow
its viewport (40 alternating messages were used for the September 2026 fix).
Copilot rendering hooks can return null for this text-only fixture; no agent call
is required.

1. Render history plus a final user message with `busy=true`. Wait for layout.
2. Replace the Thinking indicator with an assistant message (same child count).
   The viewport must stay at the end, not jump to the first historical user turn.
3. Grow that same assistant message until it exceeds a viewport; allow the resize
   observer to settle. The viewport must follow the end.
4. Press PageUp inside Messages and allow the scroll to settle. Append more text.
   The viewport must keep the reader's position while scrollHeight increases.
5. Finish streaming. The position must remain unchanged. Scroll to end must restore
   following, and a new channel must open at the end.

Root cause: @shadcn/react's unchanged-child-count branch chooses the first unseen
scrollAnchor. Historical user anchors were not all marked seen on initialization,
so replacing Thinking could choose the very first question. ChatTranscript now
uses bottom-following without per-message anchors.

Observed before fix: scrollTop 2696 -> 0 on the first token.
Observed after fix: 2696 -> 2737.5 (new bottom); manual position 2904 remained
2904 while maximum scroll increased from 3228 to 3484. Verified using the actual
ChatTranscript in the Codex browser. App typecheck and production build passed.
