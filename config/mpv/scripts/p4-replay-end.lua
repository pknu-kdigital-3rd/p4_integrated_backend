-- Display an explicit camera-readable endpoint at EOF, independent of GPS timestamps.
-- Marker protocol: P4_REPLAY_END_V1. Requires Android support for this marker.
local mp = require 'mp'
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

local function draw_marker()
    if not ended then overlay:remove(); return end
    local width, height = mp.get_osd_size()
    if not width or not height or width <= 0 or height <= 0 then return end
    local size = #matrix
    local scale = math.max(1, math.floor(math.min(width * 0.45, height * 0.40) / size))
    local x = math.floor((width - size * scale) / 2)
    local y = math.floor(height - size * scale - height * 0.06)
    local paths = {}
    for row = 1, size do
        for col = 1, size do
            if matrix[row]:sub(col, col) == '1' then
                local left, top = x + (col - 1) * scale, y + (row - 1) * scale
                paths[#paths + 1] = string.format('m %d %d l %d %d %d %d %d %d',
                    left, top, left + scale, top, left + scale, top + scale, left, top + scale)
            end
        end
    end
    -- Cover the old timestamp QR throughout Android's bottom-center scan area.
    local panel_top = math.floor(height * 0.40)
    local prefix = '{\\an7\\pos(0,0)\\bord0\\shad0\\1a&H00&\\p1'
    overlay.res_x, overlay.res_y = width, height
    overlay.data = prefix .. '\\1c&HFFFFFF&}m 0 ' .. panel_top .. ' l ' .. width .. ' ' .. panel_top ..
        ' ' .. width .. ' ' .. height .. ' 0 ' .. height .. '\n' ..
        prefix .. '\\1c&H000000&}' .. table.concat(paths, ' ')
    overlay:update()
end

mp.observe_property('eof-reached', 'bool', function(_, value)
    ended = value == true
    draw_marker()
end)
mp.observe_property('osd-dimensions', 'native', function() draw_marker() end)
mp.register_event('file-loaded', function() ended = false; overlay:remove() end)
mp.register_event('shutdown', function() overlay:remove() end)
