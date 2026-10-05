-- Display an explicit camera-readable endpoint at EOF, independent of GPS timestamps.
-- Marker protocol: P4_REPLAY_END_V1. Requires Android support for this marker.
local mp = require 'mp'
local options = require 'mp.options'
local overlay = mp.create_osd_overlay('ass-events')
local ended = false
local matrix = {}
for row in ([=[
00000000000000000000000000000
00000000000000000000000000000
00000000000000000000000000000
00000000000000000000000000000
00001111111010010011111110000
00001000001011001010000010000
00001011101011111010111010000
00001011101011100010111010000
00001011101001111010111010000
00001000001010111010000010000
00001111111010101011111110000
00000000000000001000000000000
00001100111000010001011110000
00001101110101111110011000000
00000111111001000100110000000
00000011010111010101100000000
00001001111010011011111110000
00000000000011101100010010000
00001111111001000100101100000
00001000001010011101100000000
00001011101011010010011110000
00001011101001101001001010000
00001011101001000110111000000
00001000001011000100100000000
00001111111010011111001010000
00000000000000000000000000000
00000000000000000000000000000
00000000000000000000000000000
00000000000000000000000000000
]=]):gmatch('[01]+') do matrix[#matrix + 1] = row end

-- Where bake_timecode.py burns the timestamp QR, in video pixels: a qr_size
-- square, bottom-center, margin pixels above the bottom edge. Match its
-- --qr-size/--margin (defaults 160/12) in script-opts/p4-replay-end.conf.
local opts = { qr_size = 160, margin = 12 }
options.read_options(opts, 'p4-replay-end')

-- The matrix has a 4-module quiet zone; the baked QR (qrcode border=2) has 2.
-- Keep 2 so the marker's modules line up with the timestamp QR it replaces.
local first = 1 + (4 - 2)
local marker = {}
for row = first, #matrix - first + 1 do
    marker[#marker + 1] = matrix[row]:sub(first, #matrix - first + 1)
end

local function rect(left, top, right, bottom)
    return string.format('m %d %d l %d %d %d %d %d %d', left, top, right, top, right, bottom, left, bottom)
end

local function draw_marker()
    if not ended then overlay:remove(); return end
    local osd = mp.get_property_native('osd-dimensions')
    local video = mp.get_property_native('video-params')
    if not osd or not video or not osd.w or osd.w <= 0 or osd.h <= 0
        or not video.w or video.w <= 0 or not video.h or video.h <= 0 then return end
    -- The video's rectangle inside the window (letterbox/pillarbox margins).
    local sx = (osd.w - osd.ml - osd.mr) / video.w
    local sy = (osd.h - osd.mt - osd.mb) / video.h
    local qr_x = math.floor((video.w - opts.qr_size) / 2)
    local qr_y = video.h - opts.margin - opts.qr_size
    local left, top = osd.ml + qr_x * sx, osd.mt + qr_y * sy
    local width, height = opts.qr_size * sx, opts.qr_size * sy
    local size = #marker
    -- Round each module edge from the patch origin so modules tile without gaps.
    local function edge_x(i) return math.floor(left + i * width / size + 0.5) end
    local function edge_y(i) return math.floor(top + i * height / size + 0.5) end
    local paths = {}
    for row = 1, size do
        for col = 1, size do
            if marker[row]:sub(col, col) == '1' then
                paths[#paths + 1] = rect(edge_x(col - 1), edge_y(row - 1), edge_x(col), edge_y(row))
            end
        end
    end
    -- White only where the baked QR patch is (one extra pixel hides its edge).
    local patch = rect(edge_x(0) - 1, edge_y(0) - 1, edge_x(size) + 1, edge_y(size) + 1)
    local prefix = '{\\an7\\pos(0,0)\\bord0\\shad0\\1a&H00&\\p1'
    overlay.res_x, overlay.res_y = osd.w, osd.h
    overlay.data = prefix .. '\\1c&HFFFFFF&}' .. patch .. '\n' ..
        prefix .. '\\1c&H000000&}' .. table.concat(paths, ' ')
    overlay:update()
end

mp.observe_property('eof-reached', 'bool', function(_, value)
    ended = value == true
    draw_marker()
end)
mp.observe_property('osd-dimensions', 'native', function() draw_marker() end)
mp.observe_property('video-params', 'native', function() draw_marker() end)
mp.register_event('file-loaded', function() ended = false; overlay:remove() end)
mp.register_event('shutdown', function() overlay:remove() end)
