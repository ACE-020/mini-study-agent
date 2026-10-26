"use strict";
// 仅补充可确定的数学标记；绝不把 x2 猜成 x^2，丢失的结构仍需看原页。
function exerciseMathMarkup(value){
 const source=String(value||""),protectedParts=[];
 const protectedText=source.replace(/```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\$)\$(?!\$)[^\n$]+?\$(?!\$)|\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\}/g,part=>{protectedParts.push(part);return `EXERCISEMATHKEEP${protectedParts.length-1}END`;});
 const converted=protectedText.split(/([\u3400-\u9fff，。；：！？\n]+)/).map(part=>{
  if(!part.trim()||/[\u3400-\u9fff]/.test(part)||part.includes("EXERCISEMATHKEEP"))return part;
  if(!/\\(?:frac|sqrt|lim|sum|int|begin)|\blim\s*[_({]|[a-zA-Z]\s*\^|(?:sin|cos|arctan)\s*[(a-zA-Z]|[∫√]/.test(part))return part;
  const names=part.match(/[a-zA-Z]{3,}/g)||[];
  if(names.some(name=>!["frac","sqrt","lim","sum","int","infty","sin","cos","tan","cot","sec","csc","arctan","arcsin","arccos","ln","log","exp","left","right","cdot","times","to","begin","end","cases","otherwise","text"].includes(name)))return part;
  let math=part.trim().replace(/→/g,"\\to ").replace(/∞/g,"\\infty ").replace(/−/g,"-").replace(/²/g,"^{2}").replace(/³/g,"^{3}");
  math=math.replace(/(^|[^\\a-zA-Z])(lim|sin|cos|tan|arctan|arcsin|arccos|ln|log|exp)(?=\b|[_({])/g,"$1\\$2");
  math=math.replace(/√\(([^()]*)\)/g,"\\sqrt{$1}").replace(/√([a-zA-Z0-9])/g,"\\sqrt{$1}");
  if(math.includes("√"))return part;
  return part.slice(0,part.length-part.trimStart().length)+"\\("+math+"\\)"+part.slice(part.trimEnd().length);
 }).join("");
 return converted.replace(/EXERCISEMATHKEEP(\d+)END/g,(_,index)=>protectedParts[Number(index)]);
}
function exerciseRich(element,value){rich(element,exerciseMathMarkup(value));}
function exerciseNeedsReview(value){return /\[无法辨认\]|\[待核对\]/.test(value)||(!/\$|\\\(|\\\[/.test(value)&&/\b(?:lim_|[exyz]\d|f\s*[−-]1\()/.test(value));}
