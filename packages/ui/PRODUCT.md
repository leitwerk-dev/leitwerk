# Product

## Register

product

## Users

Primary users are platform and developer-tools operators supervising multiple AI-assisted software delivery processes. They launch processes, monitor active work, inspect history, understand the current turn, intervene with guidance or actions, and recover when something goes wrong. The highest-pressure surface is the process detail view, where users need situational awareness and confident control without being forced to reconstruct state from scattered signals.

## Product Purpose

Leitwerk is the control unit for AI-driven software delivery. It is a process-centric control plane. The UI exists to make complex process state inspectable and steerable: start the right process, understand what happened and what is happening now, choose the next operator action, and recover safely from errors or interruptions. It also lets operators browse installed and remote skills, maintain repository-installed revisions, and inspect their usage. Success looks like an operator quickly knowing where attention is needed and what control is available next.

## Brand Personality

Calm, approachable, high-control.

The product should feel clean in the way ChatGPT and Claude feel clean: readable, quiet, spacious enough to think, and focused on the work rather than interface ornament. It should be trustworthy and operational rather than flashy or theatrical. Users should feel like they are in command of a complex system, not deciphering one.

## Anti-references

Do not make the UI feel like a flashy AI SaaS dashboard, a dense terminal cosplay surface, or a decorative demo. Avoid visual patterns that make state harder to scan: excessive gradients, theatrical motion, ornamental cards, tiny uppercase page kickers, section eyebrows, cryptic status language, and sticky/near-header action command strips on process detail pages. Do not hide recovery paths or next actions behind clever affordances. Preserve the inline chronicle/action section as the canonical detailed surface; a compact bottom composer may expose the shared action draft while the operator reads a waiting result, but it must not duplicate runtime configuration or cover result content.

## Design Principles

1. Make current state unmistakable: users should immediately see what is active, what changed, and what needs attention.
2. Reduce supervisory load: complex process history should be chunked and prioritized so operators do not have to mentally reconstruct status.
3. Keep control surfaces obvious: next actions, recovery paths, and steering inputs should be discoverable without hunting.
4. Stay calm under stress: error, reconnect, and warning states should feel trustworthy and actionable, not alarming or cryptic.
5. Approachability without softness: use warm, readable presentation, but preserve the precision and density needed for operator workflows.

## Accessibility & Inclusion

Target WCAG 2.2 AA. The UI should remain keyboard-first, screen-reader intelligible, and usable with reduced motion. Body text and form hints must meet contrast requirements, focus states must be visible, status changes should be announced or otherwise perceivable, and color must never be the only carrier of process state.
