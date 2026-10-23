# Landscape guide

Arch writes this guide into the BUILDERS.md of every project of this kind, after the core standards. Its source is packages/project-tools/src/rules.ts: change it there, and a test keeps this copy equal.

A landscape is a garden, park or planting design: terrain, paths, water, planting and the furniture that serves them. Identify the surveyed extents, ground levels, existing trees and planting to keep, soil and water features, and the orientation unless facts.north holds it. Planting is the main material: give beds, lawns and meadows their own material keys and mass the planting in layers of trees, shrubs and ground cover.

### Ground and walls

A plan's walls list may be empty. Use walls only where something really stands: façades that bound the space, low walls, seat walls, retaining walls and kerbs high enough to matter, each with its real height and thickness. Openings belong only where such a wall has one. A plan without walls gets no ceilings and no roof slab.

The ground is part of the design. Flat paved zones, lawns and beds can be rooms: a polygon with a floor material. Rooms on a level without walls are open to the sky; on a level with walls, such as a courtyard, set ceiling:false. Ground that slopes or steps is one or a few furniture pieces with ground:true and a model the generator writes, positioned at the footprint centre with size equal to its extents. Walk mode follows a ground model's surface and sections never cut it. Keep the ground continuous: no gaps between zones, nothing floating above it and nothing sunk into it.

### Terrain from the references

Build terrain from survey data when the references hold it, and from drawn contours or spot heights when they do not. Record the source, units and datum in arch.context.json decisions, and choose one site origin in plan [0,0].

- DXF: read POINT, 3D polyline and LWPOLYLINE entities; contour polylines carry their height as elevation or Z. Check INSUNITS for units.
- CSV: columns of x, y and z, or of latitude, longitude and height. Read the header and check whether coordinates are projected metres (for example UTM) or degrees.
- GeoJSON: Point features with a height property or a third coordinate, and LineString contours with an elevation property. Coordinates are WGS84 longitude, latitude.
- Degrees to metres around the site origin (lat0, lon0): east = (lon − lon0) × 111320 × cos(lat0), north = (lat − lat0) × 110574. Then into plan axes with θ = facts.north (0 when absent): x = east × cos θ + north × sin θ, y = east × sin θ − north × cos θ.
- Heights count from the level's floor. Set the main level to height 0 at a datum you record, usually the lowest point or the principal paving level.
- Sample the heights onto a regular grid and write it as a GLB, as "Dependencies" in BUILDERS.md describes. A grid spacing of 0.5 to 2 m suits a plaza and 2 to 10 m a large site; use a coarser grid where the ground is flat.

### Hardscape, steps and ramps

Paving, kerbs, edges, channels and drains follow the drawings. Give each paving its real module through the material's pattern and module, such as large-tiles at [0.6,0.3] for slabs or tiles at [0.1,0.2] for setts. Keep falls the drawings show.

Steps have equal risers and treads within a flight. Where the brief names no local standard, use risers of 0.15 m or less with treads of 0.3 to 0.4 m outdoors, ramps no steeper than 1:12 with level landings at least 1.5 m long at the top, at the bottom and after every 0.75 m of rise, and handrails on both sides of ramps and long flights. Model steps and ramps into the ground model or as stairs and box pieces; walk mode must climb them.

### Planting and furniture

Trees, shrubs, benches, bins, bollards, lights, bicycle stands and play equipment come from the catalog at real size: search_catalog searches the local library and NVIDIA SimReady. Place trees with their real canopy and trunk sizes for the age the brief describes, and keep paths and sight lines clear. Reuse one model per species or product; every copy still counts against the triangle budget.

### Extents and budgets

Model the space to its real boundary from the survey or plan, plus a strip of context, such as surrounding façades as simple massing walls or boxes and the adjoining streets. Never shrink a site to fit a room-sized scene, and never model kilometres of context nobody sees.

At site scale the triangle budget goes fast. Keep the ground model under 100,000 triangles, each tree under 20,000 and the walk-mode total under 500,000 for a look. Prefer low-poly species and fewer distinct models over dense scans.

Cameras stand on the ground: on sloping terrain set height to the ground height under the camera plus 1.6 m. Review views at eye height from the main approaches and one view from above.
