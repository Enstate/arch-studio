# Interior guide

Arch writes this guide into the BUILDERS.md of every project of this kind, after the core standards. Its source is packages/project-tools/src/rules.ts: change it there, and a test keeps this copy equal.

An interior is a fit-out inside a given shell: rooms, finishes, joinery, furniture and lighting. Identify the shell's walls, openings, columns, ceiling heights and services from the survey or plan, unless the facts already hold storeyHeight or north.

- Draw the shell's walls and openings at their real positions and thickness, including walls that stay unchanged, so rooms close and walk mode has bounds. Walls the brief removes or adds are design decisions: list them in arch.context.json decisions, and ask before moving a structural wall or a riser.
- Door swings, windows, columns and service positions stay as drawn. Keep doorways and walking paths clear, with at least 0.9 m of passage where the brief names no local standard.
- Set each room's ceilingHeight from facts.storeyHeight less the slab, or from the survey. A lowered ceiling or bulkhead is a ceilingHeight on that room or a box piece, never a raised floor.
- An interior over several floors lists them in levels, with stairs pieces as the plan contract describes. Never fake an upper storey with a storey-sized model or raised furniture.
- Built-in joinery, kitchens, wardrobes and lighting are fixture:true. Loose furniture comes from the catalog at real size, or as custom models when the brief asks for bespoke pieces.
- The outside is context. Flat ground and the default sky are enough unless the brief asks for a view out.
