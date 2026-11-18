// 临时检查页：确认 mp-html + KaTeX 在本机渲染正常。确认后删除。
Page({
  data: {
    sample: '设 $a_n=\\ln(1+n)-\\left(1+\\frac{1}{2}+\\frac{1}{3}+\\cdots+\\frac{1}{n}\\right)=\\ln(1+n)-H_n$。\n\n'
      + '要证明收敛，先看相邻两项之差：\n\n'
      + '$$ a_{n+1}-a_n=\\ln(2+n)-\\ln(1+n)-\\frac{1}{n+1} $$\n\n'
      + '用求和符号写：$a_n=\\ln(1+n)-\\sum_{k=1}^{n}\\frac{1}{k}$，'
      + '矩阵里则是 $A^{-1}=\\frac{1}{|A|}A^{*}$，$\\sqrt{x^2+1}$，$e^x\\ge ex$。'
  }
});
