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


# At most this share of GPS anchors may lack a nearby road (for example a
# campus road the routing graph leaves out) before the whole match fails.
MAX_SKIPPED_ANCHOR_SHARE = 0.25


def match_preview(graph, records, spatial_index, long_records, bucket_size, points, failure=None):
    """Return road geometry and each GPS anchor's index on it, or None.

    An anchor with no road within reach is skipped and bridged over, up to
    MAX_SKIPPED_ANCHOR_SHARE of them; it takes the preceding matched anchor's
    position so positions stay non-decreasing, and is listed in
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
    matched = [index for index, row in enumerate(rows) if row]
    skipped = [index for index, row in enumerate(rows) if not row]
    if len(matched) < 2 or len(skipped) > len(points) * MAX_SKIPPED_ANCHOR_SHARE:
        return fail("no_road_nearby", skipped[0], radius_m=120, unmatched=len(skipped), anchors=len(points))
    matched_points = [points[index] for index in matched]
    chosen = _choose_sequence(matched_points, [rows[index] for index in matched])
    path = [list(chosen[0]["snap"])]
    matched_positions = [0]
    for step, (previous, current) in enumerate(zip(chosen, chosen[1:])):
        section_start = len(path) - 1
        if previous["id"] == current["id"] and current["progress"] >= previous["progress"]:
            if previous["segment"] == current["segment"]:
                _append(path, [current["snap"]])
            else:
                _append(path, previous["geometry"][previous["segment"]:current["segment"]])
                _append(path, [current["snap"]])
        else:
            _append(path, _edge_after(previous))
            if previous["end"] != current["start"]:
                bridge = graph.route(previous["end"], current["start"])
                if bridge is None:
                    return fail("no_connection", matched[step + 1])
                _append(path, bridge.coords)
            _append(path, _edge_before(current))
        road_m = sum(haversine_m(*path[index - 1], *path[index])
                     for index in range(section_start + 1, len(path)))
        # Across a skipped anchor this is the GPS distance between the matched
        # anchors on either side, so a bridged gap is held to the same limit.
        gps_m = haversine_m(*matched_points[step], *matched_points[step + 1])
        if road_m > max(250, 4 * gps_m + 150):
            return fail("detour_too_long", matched[step + 1], road_m=round(road_m), gps_m=round(gps_m))
        matched_positions.append(len(path) - 1)
    position_by_anchor = dict(zip(matched, matched_positions))
    snap_by_anchor = {anchor: round(candidate["distance"], 1) for anchor, candidate in zip(matched, chosen)}
    positions, snaps, last_position = [], [], 0
    for anchor in range(len(points)):
        last_position = position_by_anchor.get(anchor, last_position)
        positions.append(last_position)
        snaps.append(snap_by_anchor.get(anchor))
    return {"coordinates": [[lon, lat] for lat, lon in path], "anchorPositions": positions,
            "snapDistancesM": snaps, "skippedAnchors": skipped}
