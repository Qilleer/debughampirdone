const TelegramBot = require('node-telegram-bot-api');
const { restoreAllSessions } = require('./whatsappClient');
const { handleAuthCallbacks, handleAuthMessages } = require('./handlers/authHandler');
const { handleAdminCallbacks, handleAdminMessages } = require('./handlers/adminHandler');
const { handleGroupCallbacks, handleGroupMessages } = require('./handlers/groupHandler');
const { handleCtcCallbacks, handleCtcMessages } = require('./handlers/ctcHandler');
const { handleBlastCallbacks, handleBlastMessages } = require('./handlers/blastHandler');
const { handleSessionCallbacks, handleSessionMessages, autoInitializeSessions, checkFeatureAccess } = require('./handlers/sessionHandler');
const { 
  showMainMenu, 
  showSessionManager, 
  showPaymentMenu, 
  checkPaymentStatus, 
  cancelPayment, 
  paymentManager 
} = require('./handlers/menuHandler');
const { isOwner, parsePhoneNumbersFromFile } = require('./utils/helpers');
const UserFileManager = require('./utils/userFileManager');
const config = require('./config');

// Bot instance & user states
const bot = new TelegramBot(config.telegram.token, { polling: true });
const userStates = {};

// Initialize bot - restore sessions and migrate data on startup
async function initializeBot() {
  console.log('🔄 Initializing bot with premium multi-session support...');
  
  try {
    // Initialize file system
    await UserFileManager.initializeDirectories();
    console.log('✅ File system initialized');

    // Migrate from old users.json format if exists
    await UserFileManager.migrateFromOldFormat();
    console.log('✅ Data migration completed');

    // Initialize user sessions from file data
    console.log('🔄 Initializing user sessions...');
    const restoredCount = await autoInitializeSessions(userStates, bot);
    
    if (restoredCount > 0) {
      console.log(`✅ Restored ${restoredCount} user sessions`);
      
      // Notify owners about restored sessions
      for (const ownerId of config.telegram.owners) {
        try {
          await bot.sendMessage(
            ownerId, 
            `🚀 *Bot Started!*\n\n✅ Restored ${restoredCount} WhatsApp session(s)\n\nBot premium multi-session siap digunakan!`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          console.warn(`Could not notify owner ${ownerId}:`, err.message);
        }
      }
    } else {
      console.log('ℹ️ No existing sessions found');
    }

    // Start payment checker
    startPaymentChecker();
    console.log('✅ Payment checker started');

  } catch (err) {
    console.error('❌ Error during bot initialization:', err.message);
  }
}

// Start payment checker for automatic payment processing
function startPaymentChecker() {
  setInterval(async () => {
    try {
      const successfulPayments = await paymentManager.checkAllPendingPayments();
      
      for (const transaction of successfulPayments) {
        try {
          // Send notification to user
          await bot.sendMessage(
            transaction.user_id,
            `✅ *Pembayaran Berhasil!*\n\n` +
            `🆔 ID Transaksi: ${transaction.id}\n` +
            `💰 Jumlah: Rp ${transaction.base_amount.toLocaleString()}\n` +
            `📦 Paket: ${transaction.description}\n\n` +
            `🎉 Premium Anda telah diaktifkan!\n` +
            `Silahkan buka Session Manager untuk mulai menggunakan fitur premium.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📱 Session Manager', callback_data: 'session_manager' }],
                  [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
                ]
              }
            }
          );
        } catch (txError) {
          console.error(`Error processing payment notification ${transaction.id}:`, txError);
        }
      }
    } catch (error) {
      console.error('Error in payment checker:', error);
    }
  }, 60000); // Check every minute
}

// Handle /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isOwner(userId)) {
    await bot.sendMessage(chatId, '❌ Bot ini hanya untuk owner yang terdaftar!');
    return;
  }
  
  // Save/update user info
  await UserFileManager.saveUser(userId, {
    username: msg.from.username,
    first_name: msg.from.first_name
  });
  
  await showMainMenu(chatId, bot, userStates);
});

// Handle callback queries
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  
  if (!isOwner(userId)) {
    try {
      await bot.answerCallbackQuery(query.id, { 
        text: '❌ Lu bukan owner!', 
        show_alert: true 
      });
    } catch (err) {
      console.warn(`Failed to answer callback query: ${err.message}`);
    }
    return;
  }
  
  try {
    console.log(`[DEBUG] Callback data received: ${data} from user ${userId}`);
    
    // Route callbacks berdasarkan prioritas
    
    // SESSION MANAGEMENT - PRIORITAS TERTINGGI
    if (data === 'session_manager' || 
        data.startsWith('switch_slot_') || 
        data.startsWith('login_slot_') || 
        data.startsWith('logout_slot_') || 
        data.startsWith('setup_slot_') ||
        data === 'buy_additional_slot' ||
        data === 'buy_premium_first') {
      console.log(`[DEBUG] Routing to Session handler: ${data}`);
      await handleSessionCallbacks(query, bot, userStates);
    }
    
    // PAYMENT MANAGEMENT
    else if (data.startsWith('check_payment_') ||
             data.startsWith('cancel_payment_')) {
      const transactionId = data.replace('check_payment_', '').replace('cancel_payment_', '');
      
      if (data.startsWith('check_payment_')) {
        await checkPaymentStatus(chatId, bot, transactionId, query.message.message_id);
      } else {
        await cancelPayment(chatId, bot, transactionId, query.message.message_id);
      }
    }
    
    // BLAST HANDLER
    else if (data === 'blast' || 
        data === 'blast_chat' || 
        data === 'blast_file' ||
        data === 'confirm_blast_numbers' ||
        data === 'confirm_blast' ||
        data === 'custom_delay' ||
        data === 'cancel_blast_flow' ||
        data.startsWith('set_delay_')) {
      console.log(`[DEBUG] Routing to Blast handler: ${data}`);
      
      // Check premium access for blast
      const hasAccess = await checkFeatureAccess(userId, 'basic');
      if (!hasAccess) {
        await bot.answerCallbackQuery(query.id, {
          text: '🚫 Fitur ini memerlukan premium!',
          show_alert: true
        });
        return;
      }
      
      await handleBlastCallbacks(query, bot, userStates);
    }
    
    // CTC HANDLER  
    else if (data === 'add_ctc' || 
        data === 'add_ctc_chat' || 
        data === 'add_ctc_file' ||
        data === 'confirm_ctc_numbers' ||
        data === 'search_ctc_groups' ||
        data === 'finish_ctc_group_selection' ||
        data === 'confirm_add_ctc' ||
        data === 'cancel_ctc_flow' ||
        data.startsWith('toggle_ctc_group_') || 
        data.startsWith('ctc_groups_page_')) {
      console.log(`[DEBUG] Routing to CTC handler: ${data}`);
      
      // Check premium access for CTC
      const hasAccess = await checkFeatureAccess(userId, 'basic');
      if (!hasAccess) {
        await bot.answerCallbackQuery(query.id, {
          text: '🚫 Fitur ini memerlukan premium!',
          show_alert: true
        });
        return;
      }
      
      await handleCtcCallbacks(query, bot, userStates);
    }
    
    // AUTH HANDLER (Updated for multi-session)
    else if (data.startsWith('login') || data.startsWith('cancel_login') || data.startsWith('logout') || 
             data === 'auto_accept' || data === 'toggle_auto_accept' || data === 'status') {
      
      // Check premium access for auth features
      if (data === 'login' || data === 'auto_accept' || data === 'toggle_auto_accept') {
        const hasAccess = await checkFeatureAccess(userId, 'basic');
        if (!hasAccess) {
          await bot.answerCallbackQuery(query.id, {
            text: '🚫 Fitur ini memerlukan premium!',
            show_alert: true
          });
          return;
        }
      }
      
      await handleAuthCallbacks(query, bot, userStates);
    }
    
    // ADMIN HANDLER
    else if (data.startsWith('admin_') || data.startsWith('add_promote') || data.startsWith('demote_') || 
             data.startsWith('toggle_group_') || data.startsWith('groups_page_') || data.startsWith('search_') ||
             data.startsWith('finish_') || data.startsWith('confirm_') || data.startsWith('cancel_admin') ||
             data.startsWith('start_search') || data.startsWith('toggle_demote')) {
      
      // Check premium access for admin features
      const hasAccess = await checkFeatureAccess(userId, 'basic');
      if (!hasAccess) {
        await bot.answerCallbackQuery(query.id, {
          text: '🚫 Fitur ini memerlukan premium!',
          show_alert: true
        });
        return;
      }
      
      await handleAdminCallbacks(query, bot, userStates);
    }
    
    // GROUP HANDLER
    else if (data.startsWith('rename_') || data.startsWith('select_base_') || data.startsWith('confirm_rename')) {
      
      // Check premium access for group features
      const hasAccess = await checkFeatureAccess(userId, 'basic');
      if (!hasAccess) {
        await bot.answerCallbackQuery(query.id, {
          text: '🚫 Fitur ini memerlukan premium!',
          show_alert: true
        });
        return;
      }
      
      await handleGroupCallbacks(query, bot, userStates);
    }
    
    // MAIN MENU
    else if (data === 'main_menu') {
      await showMainMenu(chatId, bot, userStates, query.message.message_id);
    }
    
    else {
      console.log(`[DEBUG] Unhandled callback data: ${data}`);
      await bot.sendMessage(chatId, '❌ Command tidak dikenal. Coba lagi ya!');
    }
    
  } catch (err) {
    console.error('Error handling callback:', err);
    try {
      await bot.sendMessage(chatId, '❌ Terjadi error saat memproses perintah. Coba lagi ya!');
    } catch (sendErr) {
      console.error('Failed to send error message:', sendErr.message);
    }
  }
  
  // Answer callback query with error handling
  try {
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.warn(`Failed to answer callback query: ${err.message}`);
  }
});

// Handle text messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  if (!text || text.startsWith('/')) return;
  if (!isOwner(userId)) return;
  
  try {
    // Route messages to appropriate handlers
    let handled = false;
    
    // Try session handler first (untuk phone number input, etc)
    handled = await handleSessionMessages(msg, bot, userStates);
    
    // If not handled by session, try blast handler
    if (!handled) {
      // Check premium access for blast
      const hasAccess = await checkFeatureAccess(userId, 'basic');
      if (hasAccess) {
        handled = await handleBlastMessages(msg, bot, userStates);
      }
    }
    
    // If not handled by blast, try auth handler
    if (!handled) {
      handled = await handleAuthMessages(msg, bot, userStates);
    }
    
    // If not handled by auth, try admin handler
    if (!handled) {
      // Check premium access for admin
      const hasAccess = await checkFeatureAccess(userId, 'basic');
      if (hasAccess) {
        handled = await handleAdminMessages(msg, bot, userStates);
      }
    }
    
    // If not handled by admin, try group handler
    if (!handled) {
      // Check premium access for group
      const hasAccess = await checkFeatureAccess(userId, 'basic');
      if (hasAccess) {
        handled = await handleGroupMessages(msg, bot, userStates);
      }
    }
    
    // If not handled by group, try CTC handler
    if (!handled) {
      // Check premium access for CTC
      const hasAccess = await checkFeatureAccess(userId, 'basic');
      if (hasAccess) {
        handled = await handleCtcMessages(msg, bot, userStates);
      }
    }
    
    // If no handler processed it, ignore
    if (!handled) {
      console.log(`[DEBUG] Unhandled message from ${userId}: ${text}`);
    }
    
  } catch (err) {
    console.error('Error handling message:', err);
    try {
      await bot.sendMessage(chatId, '❌ Terjadi error. Coba lagi ya!');
    } catch (sendErr) {
      console.error('Failed to send error message:', sendErr.message);
    }
  }
});

// Handle document uploads untuk file TXT (CTC & Blast) - Updated dengan premium check
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const document = msg.document;
  
  if (!isOwner(userId)) return;
  
  // Check premium access
  const hasAccess = await checkFeatureAccess(userId, 'basic');
  if (!hasAccess) {
    await bot.sendMessage(chatId, '🚫 *Premium Required*\n\nFitur upload file hanya tersedia untuk pengguna premium.', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Beli Premium', callback_data: 'buy_premium_first' }]
        ]
      }
    });
    return;
  }
  
  // Check if user is in CTC flow waiting for file
  if (userStates[userId]?.ctcFlow && userStates[userId].ctcFlow.step === 'waiting_file') {
    try {
      // Validate file type
      if (!document.file_name.toLowerCase().endsWith('.txt')) {
        await bot.sendMessage(chatId, '❌ File harus berformat .txt!');
        return;
      }
      
      // Validate file size (max 5MB)
      if (document.file_size > 5 * 1024 * 1024) {
        await bot.sendMessage(chatId, '❌ File terlalu besar! Maksimal 5MB.');
        return;
      }
      
      const loadingMsg = await bot.sendMessage(chatId, '⏳ Memproses file...');
      
      // Download file
      const fileLink = await bot.getFileLink(document.file_id);
      const response = await fetch(fileLink);
      const fileContent = await response.text();
      
      // Parse phone numbers from file
      const { phoneNumbers, errors } = parsePhoneNumbersFromFile(fileContent);
      
      if (errors.length > 0) {
        await bot.editMessageText(
          `❌ Ada error dalam file:\n\n${errors.slice(0, 10).join('\n')}${errors.length > 10 ? `\n... dan ${errors.length - 10} error lainnya` : ''}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id
          }
        );
        return;
      }
      
      if (phoneNumbers.length === 0) {
        await bot.editMessageText('❌ Tidak ada nomor valid yang ditemukan dalam file!', {
          chat_id: chatId,
          message_id: loadingMsg.message_id
        });
        return;
      }
      
      // Store parsed numbers
      userStates[userId].ctcFlow.contactNumbers = phoneNumbers;
      userStates[userId].ctcFlow.step = 'confirm_numbers';
      
      // Delete loading message
      await bot.deleteMessage(chatId, loadingMsg.message_id);
      
      // Show confirmation
      const { showConfirmCtcNumbers } = require('./handlers/ctcHandler');
      await showConfirmCtcNumbers(chatId, userId, bot, userStates);
      
    } catch (err) {
      console.error('Error processing CTC file:', err);
      await bot.sendMessage(chatId, '❌ Error memproses file. Coba lagi ya!');
    }
    return;
  }
  
  // Check if user is in Blast flow waiting for file
  if (userStates[userId]?.blastFlow && userStates[userId].blastFlow.step === 'waiting_file') {
    try {
      // Validate file type
      if (!document.file_name.toLowerCase().endsWith('.txt')) {
        await bot.sendMessage(chatId, '❌ File harus berformat .txt!');
        return;
      }
      
      // Validate file size (max 5MB)
      if (document.file_size > 5 * 1024 * 1024) {
        await bot.sendMessage(chatId, '❌ File terlalu besar! Maksimal 5MB.');
        return;
      }
      
      const loadingMsg = await bot.sendMessage(chatId, '⏳ Memproses file...');
      
      // Download file
      const fileLink = await bot.getFileLink(document.file_id);
      const response = await fetch(fileLink);
      const fileContent = await response.text();
      
      // Parse phone numbers from file
      const { phoneNumbers, errors } = parsePhoneNumbersFromFile(fileContent);
      
      if (errors.length > 0) {
        await bot.editMessageText(
          `❌ Ada error dalam file:\n\n${errors.slice(0, 10).join('\n')}${errors.length > 10 ? `\n... dan ${errors.length - 10} error lainnya` : ''}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id
          }
        );
        return;
      }
      
      if (phoneNumbers.length === 0) {
        await bot.editMessageText('❌ Tidak ada nomor valid yang ditemukan dalam file!', {
          chat_id: chatId,
          message_id: loadingMsg.message_id
        });
        return;
      }
      
      // Store parsed numbers
      userStates[userId].blastFlow.phoneNumbers = phoneNumbers;
      userStates[userId].blastFlow.step = 'confirm_numbers';
      
      // Delete loading message
      await bot.deleteMessage(chatId, loadingMsg.message_id);
      
      // Show confirmation
      const { showConfirmBlastNumbers } = require('./handlers/blastHandler');
      await showConfirmBlastNumbers(chatId, userId, bot, userStates);
      
    } catch (err) {
      console.error('Error processing Blast file:', err);
      await bot.sendMessage(chatId, '❌ Error memproses file. Coba lagi ya!');
    }
    return;
  }
});

// Global error handlers
bot.on('error', (error) => {
  console.error('Telegram Bot Error:', error);
});

bot.on('polling_error', (error) => {
  console.error('Telegram Polling Error:', error);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Export userStates for whatsappClient
module.exports = { userStates };

// Initialize bot with session restore
initializeBot().then(() => {
  console.log('✅ Premium Multi-Session Bot started! Send /start to begin.');
}).catch(err => {
  console.error('❌ Bot initialization failed:', err);
});