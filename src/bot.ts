import { Menu } from "@grammyjs/menu";
import { Bot } from "grammy";

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!); // <-- put your bot token between the "" (https://t.me/BotFather)

// // Reply to any message with "Hi there!".
// bot.on("message", (ctx) => ctx.reply("Hi there!"));

// Create a simple menu.
const menu = new Menu("my-menu-identifier")
  .text("A", (ctx) => ctx.reply("You pressed A!")).row()
  .text("B", (ctx) => ctx.reply("You pressed B!"));

// Make it interactive.
bot.use(menu);

bot.command("start", async (ctx) => {
  // Send the menu.
  await ctx.reply("Check out this menu:", { reply_markup: menu });
});


bot.start();
