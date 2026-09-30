"""Buffered paint strokes and partial erasing in local metre coordinates."""
import math


def apply_brush(points, radius_m, restrictions):
    from shapely.geometry import LineString, Point, mapping, shape
    from shapely.ops import transform

    lat, lon = points[0][0], points[0][1]
    sx = max(1.0, 111320 * math.cos(math.radians(lat)))
    sy = 110540

    def forward(x, y, z=None):
        return (x - lon) * sx, (y - lat) * sy

    def backward(x, y, z=None):
        return x / sx + lon, y / sy + lat

    local = [((p[1] - lon) * sx, (p[0] - lat) * sy) for p in points]
    centre = Point(local[0]) if len(set(local)) == 1 else LineString(local)
    stroke = centre.buffer(radius_m, resolution=12)
    changes = []
    for restriction in restrictions:
        area = transform(forward, shape(restriction['geometry']))
        if not area.is_valid:
            area = area.buffer(0)
        if not area.intersects(stroke):
            continue
        remaining = area.difference(stroke)
        if remaining.equals(area):
            continue
        changes.append({
            'restrictionId': restriction['restrictionId'],
            'geometry': None if remaining.is_empty else mapping(transform(backward, remaining)),
        })
    return {'geometry': mapping(transform(backward, stroke)), 'changes': changes}
