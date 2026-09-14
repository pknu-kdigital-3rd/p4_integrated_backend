"""
Minimal pure-Python OSM .osm.pbf parser.
Implements just enough of the protobuf wire format + OSM PBF schema
(fileformat.proto / osmformat.proto) to extract nodes and ways.
No external dependencies (no `osmium`/`pyrosm`), since this sandbox has no network access.
"""
import struct
import zlib


def read_varint(buf, pos):
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


def zigzag_decode(n):
    return (n >> 1) ^ -(n & 1)


def parse_message(buf):
    """Generic protobuf parse: field_number -> list of raw values.
    Varints stored as int, length-delimited stored as bytes, fixed64/32 as bytes."""
    fields = {}
    pos = 0
    n = len(buf)
    while pos < n:
        tag, pos = read_varint(buf, pos)
        field_num = tag >> 3
        wire_type = tag & 0x7
        if wire_type == 0:  # varint
            val, pos = read_varint(buf, pos)
        elif wire_type == 2:  # length-delimited
            length, pos = read_varint(buf, pos)
            val = buf[pos:pos + length]
            pos += length
        elif wire_type == 1:  # fixed64
            val = buf[pos:pos + 8]
            pos += 8
        elif wire_type == 5:  # fixed32
            val = buf[pos:pos + 4]
            pos += 4
        else:
            raise ValueError(f"Unsupported wire type {wire_type}")
        fields.setdefault(field_num, []).append(val)
    return fields


def parse_packed_varints(buf):
    vals = []
    pos = 0
    n = len(buf)
    while pos < n:
        v, pos = read_varint(buf, pos)
        vals.append(v)
    return vals


def iter_blobs(path):
    """Yield (blob_type, decompressed_bytes) for each fileblock in a .osm.pbf file."""
    with open(path, 'rb') as f:
        data = f.read()
    pos = 0
    n = len(data)
    while pos < n:
        header_len = struct.unpack('>I', data[pos:pos + 4])[0]
        pos += 4
        header_buf = data[pos:pos + header_len]
        pos += header_len
        header_fields = parse_message(header_buf)
        blob_type = header_fields[1][0].decode('utf-8')
        datasize = header_fields[3][0]
        blob_buf = data[pos:pos + datasize]
        pos += datasize
        blob_fields = parse_message(blob_buf)
        if 1 in blob_fields:  # raw
            raw = blob_fields[1][0]
        elif 3 in blob_fields:  # zlib_data
            raw = zlib.decompress(blob_fields[3][0])
        else:
            raise ValueError("Unsupported blob compression")
        yield blob_type, raw


def parse_dense_nodes(dense_buf, stringtable, granularity, lat_offset, lon_offset):
    """Returns dict: node_id -> (lat, lon, tags_dict)"""
    fields = parse_message(dense_buf)
    ids = parse_packed_varints(fields[1][0]) if 1 in fields else []
    lats = parse_packed_varints(fields[8][0]) if 8 in fields else []
    lons = parse_packed_varints(fields[9][0]) if 9 in fields else []
    keys_vals = parse_packed_varints(fields[10][0]) if 10 in fields else []

    nodes = {}
    cur_id = 0
    cur_lat = 0
    cur_lon = 0
    kv_idx = 0
    for i in range(len(ids)):
        cur_id += zigzag_decode(ids[i])
        cur_lat += zigzag_decode(lats[i])
        cur_lon += zigzag_decode(lons[i])
        lat = 1e-9 * (lat_offset + (granularity * cur_lat))
        lon = 1e-9 * (lon_offset + (granularity * cur_lon))
        tags = {}
        if keys_vals:
            while kv_idx < len(keys_vals) and keys_vals[kv_idx] != 0:
                k = stringtable[keys_vals[kv_idx]]
                v = stringtable[keys_vals[kv_idx + 1]]
                tags[k] = v
                kv_idx += 2
            kv_idx += 1  # skip the 0 delimiter
        nodes[cur_id] = (lat, lon, tags)
    return nodes


def parse_way(way_buf, stringtable):
    fields = parse_message(way_buf)
    way_id = fields[1][0]
    keys = parse_packed_varints(fields[2][0]) if 2 in fields else []
    vals = parse_packed_varints(fields[3][0]) if 3 in fields else []
    tags = {stringtable[k]: stringtable[v] for k, v in zip(keys, vals)}
    refs_delta = parse_packed_varints(fields[8][0]) if 8 in fields else []
    refs = []
    cur = 0
    for d in refs_delta:
        cur += zigzag_decode(d)
        refs.append(cur)
    return way_id, refs, tags


RELATION_MEMBER_TYPE = {0: "node", 1: "way", 2: "relation"}


def parse_relation(rel_buf, stringtable):
    """Returns (relation_id, members: [(type, ref, role), ...], tags).
    OSM PBF Relation message (osmformat.proto): field 8 = member roles
    (stringtable indices), field 9 = member ids (delta-coded sint64),
    field 10 = member types (packed enum: 0=node, 1=way, 2=relation) -
    all three arrays are parallel, one entry per member in order."""
    fields = parse_message(rel_buf)
    rel_id = fields[1][0]
    keys = parse_packed_varints(fields[2][0]) if 2 in fields else []
    vals = parse_packed_varints(fields[3][0]) if 3 in fields else []
    tags = {stringtable[k]: stringtable[v] for k, v in zip(keys, vals)}
    roles_sid = parse_packed_varints(fields[8][0]) if 8 in fields else []
    memids_delta = parse_packed_varints(fields[9][0]) if 9 in fields else []
    types = parse_packed_varints(fields[10][0]) if 10 in fields else []
    members = []
    cur = 0
    for i, d in enumerate(memids_delta):
        cur += zigzag_decode(d)
        role = stringtable[roles_sid[i]] if i < len(roles_sid) else ""
        mtype = RELATION_MEMBER_TYPE.get(types[i] if i < len(types) else 0, "node")
        members.append((mtype, cur, role))
    return rel_id, members, tags


def parse_relations(path):
    """Returns [(relation_id, members, tags), ...] for every relation in the
    file - a separate pass/function from parse_pbf() (which only reads dense
    nodes + ways, primitive groups 2/3) rather than changing parse_pbf's
    return shape, since three other modules already depend on its 2-tuple.
    Relations live in primitive group field 4, one level down from where
    parse_pbf reads groups 2 (dense nodes) and 3 (ways)."""
    all_relations = []
    for blob_type, raw in iter_blobs(path):
        if blob_type != "OSMData":
            continue
        pb_fields = parse_message(raw)
        st_buf = pb_fields[1][0]
        st_fields = parse_message(st_buf)
        raw_strings = st_fields.get(1, [])
        stringtable = [s.decode("utf-8", errors="replace") for s in raw_strings]

        for pg_buf in pb_fields.get(2, []):
            pg_fields = parse_message(pg_buf)
            if 4 in pg_fields:  # relations
                for rbuf in pg_fields[4]:
                    all_relations.append(parse_relation(rbuf, stringtable))
    return all_relations


def parse_pbf(path):
    """Returns (nodes: {id: (lat, lon, tags)}, ways: [(id, refs, tags), ...])"""
    all_nodes = {}
    all_ways = []
    for blob_type, raw in iter_blobs(path):
        if blob_type != 'OSMData':
            continue
        pb_fields = parse_message(raw)
        # stringtable (field 1)
        st_buf = pb_fields[1][0]
        st_fields = parse_message(st_buf)
        raw_strings = st_fields.get(1, [])
        stringtable = [s.decode('utf-8', errors='replace') for s in raw_strings]

        granularity = zigzag_decode(pb_fields[17][0]) if 17 in pb_fields else 100
        # granularity is actually plain varint not zigzag; fix below
        granularity = pb_fields[17][0] if 17 in pb_fields else 100
        lat_offset = zigzag_decode(pb_fields[19][0]) if 19 in pb_fields else 0
        lon_offset = zigzag_decode(pb_fields[20][0]) if 20 in pb_fields else 0

        for pg_buf in pb_fields.get(2, []):
            pg_fields = parse_message(pg_buf)
            if 2 in pg_fields:  # dense nodes
                nodes = parse_dense_nodes(pg_fields[2][0], stringtable, granularity, lat_offset, lon_offset)
                all_nodes.update(nodes)
            if 1 in pg_fields:  # plain nodes (rare in road extracts, usually dense used)
                for nbuf in pg_fields[1]:
                    nf = parse_message(nbuf)
                    nid = nf[1][0]
                    lat = 1e-9 * (lat_offset + granularity * zigzag_decode(nf[8][0]))
                    lon = 1e-9 * (lon_offset + granularity * zigzag_decode(nf[9][0]))
                    keys = parse_packed_varints(nf[2][0]) if 2 in nf else []
                    vals = parse_packed_varints(nf[3][0]) if 3 in nf else []
                    tags = {stringtable[k]: stringtable[v] for k, v in zip(keys, vals)}
                    all_nodes[nid] = (lat, lon, tags)
            if 3 in pg_fields:  # ways
                for wbuf in pg_fields[3]:
                    all_ways.append(parse_way(wbuf, stringtable))
    return all_nodes, all_ways


if __name__ == '__main__':
    import sys
    nodes, ways = parse_pbf(sys.argv[1])
    print(f"Nodes: {len(nodes)}")
    print(f"Ways: {len(ways)}")
    if ways:
        wid, refs, tags = ways[0]
        print("Sample way:", wid, tags, "refs:", refs[:5], "...")
