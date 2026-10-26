-- Recognize only explicitly labeled annotations. Preserve all board numbering.
local function raw(s) return pandoc.RawBlock('latex', s) end

local function weight(block)
  local value = pandoc.utils.stringify(block)
  local n = 0
  for _, c in utf8.codes(value) do n = n + (c > 127 and 1 or 0.5) end
  pandoc.walk_block(block, {
    Math = function(m)
      if m.mathtype == 'DisplayMath' then n = n + 90 end
    end
  })
  if block.t == 'Table' then n = n + 220 end
  return n + 35
end

local function annotation_title(block)
  if block.t ~= 'BlockQuote' then return nil end
  local first = block.content[1]
  if not first or (first.t ~= 'Para' and first.t ~= 'Plain') then return nil end
  local title = first.content[1]
  if not title or title.t ~= 'Strong' then return nil end
  if not pandoc.utils.stringify(title):match('^注解') then return nil end
  return pandoc.write(pandoc.Pandoc({pandoc.Plain(title.content)}), 'latex'):gsub('%s+$', '')
end

-- Split a lengthy annotation only at an existing subheading, near its middle.
-- The score is a grouping hint; TeX measures real height and handles oversized units.
local function split_annotation(inside)
  local total, accumulated, candidates = 0, 0, {}
  for _, item in ipairs(inside) do total = total + weight(item) end
  if total <= 1500 then return {inside} end
  for index, item in ipairs(inside) do
    if index > 1 and item.t == 'Para' and item.content[1]
      and item.content[1].t == 'Strong' and accumulated >= 300
      and total - accumulated >= 300 then
      candidates[#candidates + 1] = {index=index, score=math.abs(accumulated - total * 0.6)}
    end
    accumulated = accumulated + weight(item)
  end
  table.sort(candidates, function(a, b) return a.score < b.score end)
  if #candidates == 0 then return {inside} end
  local left, right = pandoc.List(), pandoc.List()
  for index, item in ipairs(inside) do
    if index < candidates[1].index then left:insert(item) else right:insert(item) end
  end
  local parts = {}
  for _, part in ipairs(split_annotation(left)) do parts[#parts + 1] = part end
  for _, part in ipairs(split_annotation(right)) do parts[#parts + 1] = part end
  return parts
end

function Pandoc(doc)
  local blocks, board = pandoc.List(), pandoc.List()
  local function flush_board()
    if #board == 0 then return end
    blocks:insert(raw('\\begin{noteunit}'))
    blocks:extend(board)
    blocks:insert(raw('\\end{noteunit}'))
    board = pandoc.List()
  end
  for _, block in ipairs(doc.blocks) do
    local title = annotation_title(block)
    if title then
      local inside = block.content
      inside[1].content:remove(1)
      while inside[1].content[1] and inside[1].content[1].t == 'Space' do
        inside[1].content:remove(1)
      end
      if #inside[1].content == 0 then inside:remove(1) end
      local parts = split_annotation(inside)
      for index, part in ipairs(parts) do
        blocks:insert(raw('\\begin{noteunit}'))
        if index == 1 then blocks:extend(board); board = pandoc.List() end
        local label = title .. (index > 1 and '（续）' or '')
        blocks:insert(raw('\\par\\vspace{6pt}\\begin{annotationbox}{' .. label .. '}'))
        blocks:extend(part)
        blocks:insert(raw('\\end{annotationbox}\\end{noteunit}'))
      end
    else
      -- Do not collect a whole unannotated chapter into one large box.
      if block.t == 'Header' and #board > 0 and board[#board].t ~= 'Header' then
        flush_board()
      end
      board:insert(block)
    end
  end
  flush_board()
  doc.blocks = blocks
  return doc
end
