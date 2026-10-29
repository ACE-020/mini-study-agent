async function navigate(page,view){
 const button=page.locator(`[data-view="${view}"]`);
 if(!await button.isVisible())await page.locator('#task-navigation-toggle').click();
 await button.click();
}
async function utility(page,id){
 if(!await page.locator('#'+id).isVisible())await page.locator('.task-utilities>summary').click();
 await page.locator('#'+id).click();
}
async function materialText(page,text){
 if(!await page.locator('#material-text').isVisible())await page.locator('.material-supplement>summary').click();
 await page.locator('#material-text').fill(text);
}
module.exports={navigate,utility,materialText};
