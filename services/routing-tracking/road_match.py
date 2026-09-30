"""Sequence-aware GPS matching against directed road-edge geometry."""

import math

from graph_backend import _normalise_edge_geometry, haversine_m


def _bearing(a, b):
    east = (b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    north = b[0] - a[0]
    return math.atan2(east, north)


def _angle_difference(a, b):
    return abs((a - b + math.pi) % (2 * math.pi) - math.pi)


def _project(point, geometry):
    """Return distance, snapped point, and position on an oriented edge."""
    lat, lon = point
    lat_scale = 111_195
    lon_scale = lat_scale * math.cos(math.radians(lat))
    best = None
    for index in range(1, len(geometry)):
        a, b = geometry[index - 1], geometry[index]
        dx = (b[1] - a[1]) * lon_scale
        dy = (b[0] - a[0]) * lat_scale
        length_sq = dx * dx + dy * dy
        if length_sq == 0:
            continue
        x = (lon - a[1]) * lon_scale
        y = (lat - a[0]) * lat_scale
        fraction = max(0.0, min(1.0, (x * dx + y * dy) / length_sq))
        distance = math.hypot(x - fraction * dx, y - fraction * dy)
        if best is None or distance < best[0]:
            snapped = (a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1]))
            best = (distance, snapped, index, fraction, _bearing(a, b))
    return best


def _node_coords(graph, node_id):
    if hasattr(graph, "G"):
        node = graph.G.nodes[node_id]
        return (float(node["y"]), float(node["x"]))
    return graph.coords[node_id]


def _candidates(graph, point, records, spatial_index, long_records, bucket_size, limit=6, radius_m=120):
    lat, lon = point
    cell_x = math.floor(lon / bucket_size)
    cell_y = math.floor(lat / bucket_size)
    record_indices = set(long_records)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            record_indices.update(spatial_index.get((cell_x + dx, cell_y + dy), ()))
    ranked = []
    for index in record_indices:
        raw_id, physical_id, raw_geometry, _bounds = records[index]
        start, end, _key = raw_id.split(":", 2)
        start, end = int(start), int(end)
        geometry = _normalise_edge_geometry(raw_geometry, _node_coords(graph, start), _node_coords(graph, end))
        projection = _project(point, geometry)
        if projection is None or projection[0] > radius_m:
            continue
        distance, snapped, segment, fraction, bearing = projection
        ranked.append({"id": raw_id, "physical": physical_id, "start": start, "end": end,
                       "geometry": geometry, "distance": distance, "snap": snapped,
                       "segment": segment, "fraction": fraction, "bearing": bearing,
                       "progress": segment - 1 + fraction})
    ranked.sort(key=lambda item: item["distance"])
    return ranked[:limit]


def _choose_sequence(points, candidates):
    costs = []
    parents = []
    for index, row in enumerate(candidates):
        row_costs = []
        row_parents = []
        motion = None
        motion_m = 0
        if index + 1 < len(points):
            motion = _bearing(points[index], points[index + 1])
            motion_m = haversine_m(*points[index], *points[index + 1])
        elif index:
            motion = _bearing(points[index - 1], points[index])
            motion_m = haversine_m(*points[index - 1], *points[index])
        observation_m = haversine_m(*points[index - 1], *points[index]) if index else 0
        for candidate in row:
            heading_penalty = 0
            if motion is not None and motion_m < 500:
                heading_penalty = 18 * (1 - math.cos(_angle_difference(motion, candidate["bearing"])))
            emission = candidate["distance"] + heading_penalty
            if index == 0:
                row_costs.append(emission)
                row_parents.append(-1)
                continue
            best = (float("inf"), -1)
            for previous_index, previous in enumerate(candidates[index - 1]):
                snapped_m = haversine_m(*previous["snap"], *candidate["snap"])
                transition = abs(snapped_m - observation_m) * 0.3
                if previous["id"] == candidate["id"]:
                    if candidate["progress"] + 0.02 < previous["progress"]:
                        transition += 150
                    else:
                        transition -= 12
                elif previous["end"] != candidate["start"]:
                    transition += 12
                score = costs[-1][previous_index] + emission + transition
                if score < best[0]:
                    best = (score, previous_index)
            row_costs.append(best[0])
            row_parents.append(best[1])
        costs.append(row_costs)
        parents.append(row_parents)
    choice = min(range(len(costs[-1])), key=lambda index: costs[-1][index])
    chosen = []
    for index in range(len(points) - 1, -1, -1):
        chosen.append(candidates[index][choice])
        choice = parents[index][choice]
    return list(reversed(chosen))


def _append(path, section):
    for point in section:
        point = [float(point[0]), float(point[1])]
        if not path or haversine_m(*path[-1], *point) > 0.01:
            path.append(point)


def _edge_before(candidate):
    return candidate["geometry"][:candidate["segment"]] + [candidate["snap"]]


def _edge_after(candidate):
    return [candidate["snap"]] + candidate["geometry"][candidate["segment"]:]


# At most this share of GPS anchors may be dropped - no road nearby (for
# example a campus road the routing graph leaves out), or an impossible or far
# too long road path to it - before the whole match fails.
MAX_SKIPPED_ANCHOR_SHARE = 0.25
# A repair may swap an anchor's road for one at most this much farther away.
REPAIR_EXTRA_SNAP_M = 30


def _match_anchors(graph, points, rows, matched, bridges=None):
    """Build the road path through the ``matched`` anchors, in order.

    Returns {"path", "positions", "chosen"} or a failure dict naming the rule
    and the pair of anchors (``previous``, ``anchor``) it failed between.
    """
    matched_points = [points[index] for index in matched]
    chosen = _choose_sequence(matched_points, [rows[index] for index in matched])
    path = [list(chosen[0]["snap"])]
    positions = [0]
    for step, (previous, current) in enumerate(zip(chosen, chosen[1:])):
        pair = {"previous": matched[step], "anchor": matched[step + 1],
                "previous_candidate": previous, "anchor_candidate": current}
        section = _section(graph, previous, current, bridges)
        if section is None:
            return {"reason": "no_connection", **pair}
        road_m = _length_m(section)
        # Across a skipped anchor this is the GPS distance between the matched
        # anchors on either side, so a bridged gap is held to the same limit.
        gps_m = haversine_m(*matched_points[step], *matched_points[step + 1])
        if road_m > _detour_limit_m(gps_m):
            return {"reason": "detour_too_long", "road_m": round(road_m), "gps_m": round(gps_m), **pair}
        _append(path, section[1:])
        positions.append(len(path) - 1)
    return {"path": path, "positions": positions, "chosen": chosen}


def _detour_limit_m(gps_m):
    return max(250, 4 * gps_m + 150)


def _length_m(section):
    return sum(haversine_m(*section[index - 1], *section[index]) for index in range(1, len(section)))


def _section(graph, previous, current, bridges=None):
    """Road path from one snapped candidate to the next, or None if unreachable."""
    section = [list(previous["snap"])]
    if previous["id"] == current["id"] and current["progress"] >= previous["progress"]:
        if previous["segment"] != current["segment"]:
            _append(section, previous["geometry"][previous["segment"]:current["segment"]])
        _append(section, [current["snap"]])
        return section
    _append(section, _edge_after(previous))
    if previous["end"] != current["start"]:
        # Retries rebuild the whole path; most bridges between the same road
        # ends are unchanged, so reuse them.
        key = (previous["end"], current["start"])
        if bridges is not None and key in bridges:
            bridge = bridges[key]
        else:
            bridge = graph.route(previous["end"], current["start"])
            if bridges is not None:
                bridges[key] = bridge
        if bridge is None:
            return None
        _append(section, bridge.coords)
    _append(section, _edge_before(current))
    return section


def match_preview(graph, records, spatial_index, long_records, bucket_size, points, failure=None):
    """Return road geometry and each GPS anchor's index on it, or None.

    Anchors that cannot be placed are dropped and bridged over, up to
    MAX_SKIPPED_ANCHOR_SHARE of them: those with no road within reach, and
    those an impossible or far too long road path leads to - usually a snap
    onto the opposite carriageway or a one-way road driven the wrong way.
    After such a failure the later anchor is dropped first; if the retry
    fails again from the same earlier anchor, that earlier anchor is the bad
    one: it is dropped instead and the later anchor is restored. A dropped anchor takes the preceding matched
    anchor's position (positions stay non-decreasing) and is listed in
    ``skippedAnchors``. When it returns None and ``failure`` is a dict, the
    dict is filled with why: ``reason`` plus the anchor index and coordinates
    involved, so an operator can see which part of the recording could not be
    placed on the road graph.
    """
    def fail(reason, anchor, **extra):
        if failure is not None:
            lat, lon = points[anchor]
            failure.update(reason=reason, anchor=anchor, lat=round(lat, 6), lon=round(lon, 6), **extra)
        return None

    if len(points) < 2:
        return None
    rows = [_candidates(graph, point, records, spatial_index, long_records, bucket_size) for point in points]
    skipped = {index for index, row in enumerate(rows) if not row}
    # Why each anchor was dropped, for the log: no_road_nearby,
    # detour_too_long or no_connection.
    reasons = {index: "no_road_nearby" for index in skipped}
    budget = len(points) * MAX_SKIPPED_ANCHOR_SHARE
    if len(points) - len(skipped) < 2 or len(skipped) > budget:
        return fail("no_road_nearby", min(skipped), radius_m=120, unmatched=len(skipped), anchors=len(points))
    # Anchors dropped while blaming the later anchor of a failing pair, keyed
    # by that pair's earlier anchor, so they can be restored if the earlier
    # anchor turns out to be the bad one.
    dropped_after = {}
    bridges = {}
    # Before dropping an anchor, a failing pair is repaired by pinning another
    # nearby road candidate that connects within the detour limit: first for
    # the later anchor, then for the earlier one. Each (anchor, candidate) is
    # tried once, so this ends.
    pinned = {}
    tried = set()
    while True:
        matched = [index for index in range(len(points)) if index not in skipped]
        view = [[pinned[index]] if index in pinned else row for index, row in enumerate(rows)]
        outcome = _match_anchors(graph, points, view, matched, bridges)
        if "path" in outcome:
            break
        anchor, previous = outcome.pop("anchor"), outcome.pop("previous")
        previous_candidate, anchor_candidate = outcome.pop("previous_candidate"), outcome.pop("anchor_candidate")
        reason = outcome.pop("reason")
        limit_m = _detour_limit_m(haversine_m(*points[previous], *points[anchor]))

        def fits(first, second):
            section = _section(graph, first, second, bridges)
            return section is not None and _length_m(section) <= limit_m

        # Only a road about as close as the one chosen (for example the other
        # carriageway) can replace it; a far one would misplace the anchor.
        def close_to(alternative, replaced):
            return alternative["distance"] <= replaced["distance"] + REPAIR_EXTRA_SNAP_M

        repair = next(((anchor, alternative) for alternative in rows[anchor]
                       if alternative is not anchor_candidate and close_to(alternative, anchor_candidate)
                       and (anchor, alternative["id"]) not in tried
                       and fits(previous_candidate, alternative)), None)
        repair = repair or next(((previous, alternative) for alternative in rows[previous]
                                 if alternative is not previous_candidate and close_to(alternative, previous_candidate)
                                 and (previous, alternative["id"]) not in tried
                                 and fits(alternative, anchor_candidate)), None)
        if repair:
            index, alternative = repair
            tried.add((index, alternative["id"]))
            pinned[index] = alternative
            continue
        if previous in dropped_after:
            # Failing again from the same earlier anchor: it is the bad one.
            for restored in dropped_after.pop(previous):
                skipped.discard(restored)
                reasons.pop(restored, None)
            skipped.add(previous)
            reasons[previous] = reason
        else:
            dropped_after[previous] = [anchor]
            skipped.add(anchor)
            reasons[anchor] = reason
        if len(points) - len(skipped) < 2 or len(skipped) > budget:
            return fail(reason, anchor, dropped=len(skipped), anchors=len(points), **outcome)
    path, chosen = outcome["path"], outcome["chosen"]
    position_by_anchor = dict(zip(matched, outcome["positions"]))
    snap_by_anchor = {anchor: round(candidate["distance"], 1) for anchor, candidate in zip(matched, chosen)}
    positions, snaps, last_position = [], [], 0
    for anchor in range(len(points)):
        last_position = position_by_anchor.get(anchor, last_position)
        positions.append(last_position)
        snaps.append(snap_by_anchor.get(anchor))
    return {"coordinates": [[lon, lat] for lat, lon in path], "anchorPositions": positions,
            "snapDistancesM": snaps, "skippedAnchors": sorted(skipped),
            "skipReasons": {anchor: reasons.get(anchor, "no_road_nearby") for anchor in sorted(skipped)}}
