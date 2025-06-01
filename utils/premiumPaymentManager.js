const axios = require('axios');
const QRCode = require('qrcode');
const UserFileManager = require('./userFileManager');
const config = require('../config');

// Payment configuration
const PAYMENT_CONFIG = {
  OKECONNECT_ID: 'OK1382882', // Ganti dengan ID lu
  OKECONNECT_KEY: '866211317427194341382882OKCT43D3B6BB83A309E0C190B250697AB994', // Ganti dengan key lu
  QRIS_TEXT: '00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214420165790053040303UMI51440014ID.CO.QRIS.WWW0215ID20232972398650303UMI5204541553033605802ID5925RIFQILAIN STORE OK13828826011BANJARMASIN61057011162070703A0163045BE4',
  PAYMENT_TIMEOUT: 15 * 60 * 1000, // 15 menit
  
  // Pricing
  FIRST_SLOT_PRICE: 15000,  // 15k untuk slot pertama
  ADDITIONAL_SLOT_PRICE: 5000, // 5k untuk slot tambahan
  PREMIUM_DURATION_DAYS: 30 // 30 hari
};

class PremiumPaymentManager {
  constructor() {
    this.pendingTransactions = new Map(); // In-memory pending transactions
  }

  // Generate dynamic QRIS with amount
  async generateQRIS(amount) {
    try {
      if (typeof amount !== 'number') throw new Error('Amount must be a number');
      
      const staticQris = PAYMENT_CONFIG.QRIS_TEXT;
      const updatedQris = staticQris.substring(0, staticQris.length - 4);
      const step1 = updatedQris.replace("010211", "010212");
      const step2 = step1.split("5802ID");
      
      const uang = `54${amount.toString().length.toString().padStart(2, '0')}${amount}5802ID`;
      let dynamicQris = step2[0] + uang + step2[1];

      // Generate CRC
      let crc = 0xFFFF;
      for (let i = 0; i < dynamicQris.length; i++) {
        crc ^= dynamicQris.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
          crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
        }
      }
      
      dynamicQris += (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
      
      // Generate QR code as data URL
      const qrCodeDataUrl = await QRCode.toDataURL(dynamicQris, { 
        type: 'image/png', 
        width: 300, 
        margin: 1 
      });
      
      return qrCodeDataUrl;
    } catch (error) {
      console.error('Error generating QRIS:', error);
      throw error;
    }
  }

  // Generate unique amount untuk avoid collision
  generateUniqueAmount(baseAmount) {
    const existingAmounts = Array.from(this.pendingTransactions.values())
      .map(tx => tx.total_amount);
    
    let uniqueAmount = baseAmount;
    while (existingAmounts.includes(uniqueAmount)) {
      uniqueAmount++;
    }
    
    return uniqueAmount;
  }

  // Create payment transaction
  async createPayment(userId, paymentType = 'first_slot') {
    try {
      let baseAmount;
      let description;
      
      // Determine amount based on payment type
      switch (paymentType) {
        case 'first_slot':
          baseAmount = PAYMENT_CONFIG.FIRST_SLOT_PRICE;
          description = 'Premium WhatsApp Bot - 1 Slot (30 hari)';
          break;
        case 'additional_slot':
          baseAmount = PAYMENT_CONFIG.ADDITIONAL_SLOT_PRICE;
          description = 'Premium WhatsApp Bot - Slot Tambahan (30 hari)';
          break;
        case 'renewal':
          // Calculate renewal price based on user's current slots
          const userData = await UserFileManager.loadUser(userId);
          const totalSlots = userData.premium.totalSlots || 1;
          const renewalPrice = PAYMENT_CONFIG.FIRST_SLOT_PRICE + 
            ((totalSlots - 1) * PAYMENT_CONFIG.ADDITIONAL_SLOT_PRICE);
          baseAmount = renewalPrice;
          description = `Premium WhatsApp Bot - Renewal ${totalSlots} Slot(s) (30 hari)`;
          break;
        default:
          throw new Error('Invalid payment type');
      }

      // Generate unique amount
      const uniqueAmount = this.generateUniqueAmount(baseAmount);
      
      // Generate QRIS
      const qrisUrl = await this.generateQRIS(uniqueAmount);
      
      // Create transaction
      const transaction = {
        id: `tx_${Date.now()}_${userId}`,
        user_id: userId,
        payment_type: paymentType,
        base_amount: baseAmount,
        total_amount: uniqueAmount,
        description: description,
        qris_url: qrisUrl,
        status: 'pending',
        created_at: new Date().toISOString(),
        expired_at: new Date(Date.now() + PAYMENT_CONFIG.PAYMENT_TIMEOUT).toISOString()
      };

      // Store in memory
      this.pendingTransactions.set(transaction.id, transaction);

      // Auto cleanup after timeout
      setTimeout(() => {
        if (this.pendingTransactions.has(transaction.id)) {
          console.log(`🗑️ Cleaning up expired transaction: ${transaction.id}`);
          this.pendingTransactions.delete(transaction.id);
        }
      }, PAYMENT_CONFIG.PAYMENT_TIMEOUT);

      console.log(`💰 Created payment transaction: ${transaction.id} for user ${userId}`);
      return transaction;
    } catch (error) {
      console.error('Error creating payment:', error);
      throw error;
    }
  }

  // Check payment status
  async checkPaymentStatus(transactionId) {
    try {
      const transaction = this.pendingTransactions.get(transactionId);
      if (!transaction) {
        return { status: 'not_found', transaction: null };
      }

      // Check if expired
      const now = new Date();
      const expiry = new Date(transaction.expired_at);
      if (now > expiry) {
        this.pendingTransactions.delete(transactionId);
        return { status: 'expired', transaction };
      }

      // Check with payment gateway
      const response = await axios.get(
        `https://gateway.okeconnect.com/api/mutasi/qris/${PAYMENT_CONFIG.OKECONNECT_ID}/${PAYMENT_CONFIG.OKECONNECT_KEY}`
      );

      if (response.data.status !== 'success') {
        return { status: 'pending', transaction };
      }

      const mutations = response.data.data || [];
      const isPaid = mutations.some(
        mutation => String(mutation.amount).trim() === String(transaction.total_amount).trim()
      );

      if (isPaid) {
        // Process successful payment
        await this.processSuccessfulPayment(transaction);
        this.pendingTransactions.delete(transactionId);
        return { status: 'paid', transaction };
      }

      return { status: 'pending', transaction };
    } catch (error) {
      console.error('Error checking payment status:', error);
      return { status: 'error', transaction: null };
    }
  }

  // Process successful payment
  async processSuccessfulPayment(transaction) {
    try {
      const { user_id, payment_type, base_amount, id: trx_id } = transaction;

      console.log(`✅ Processing successful payment: ${trx_id} for user ${user_id}`);

      // Add payment record
      await UserFileManager.addPaymentRecord(user_id, base_amount, payment_type, trx_id);

      // Add premium based on payment type
      switch (payment_type) {
        case 'first_slot':
          await UserFileManager.addPremium(user_id, PAYMENT_CONFIG.PREMIUM_DURATION_DAYS, 1);
          break;
          
        case 'additional_slot':
          await UserFileManager.addPremium(user_id, 0, 1); // Extend slots only
          
          // Create the additional slot
          const nextSlot = await UserFileManager.getNextAvailableSlot(user_id);
          if (nextSlot) {
            await UserFileManager.createSessionSlot(user_id, nextSlot);
          }
          break;
          
        case 'renewal':
          const userData = await UserFileManager.loadUser(user_id);
          const totalSlots = userData.premium.totalSlots || 1;
          await UserFileManager.addPremium(user_id, PAYMENT_CONFIG.PREMIUM_DURATION_DAYS, 0); // Extend time only
          break;
      }

      console.log(`🎉 Premium activated for user ${user_id} - Type: ${payment_type}`);
      return true;
    } catch (error) {
      console.error('Error processing successful payment:', error);
      return false;
    }
  }

  // Cancel payment
  async cancelPayment(transactionId) {
    try {
      const transaction = this.pendingTransactions.get(transactionId);
      if (!transaction) {
        return false;
      }

      this.pendingTransactions.delete(transactionId);
      console.log(`❌ Payment cancelled: ${transactionId}`);
      return true;
    } catch (error) {
      console.error('Error cancelling payment:', error);
      return false;
    }
  }

  // Get payment info for user
  async getPaymentInfo(userId, paymentType) {
    try {
      const userData = await UserFileManager.loadUser(userId);
      let canPurchase = true;
      let reason = '';

      switch (paymentType) {
        case 'first_slot':
          if (userData.premium.totalSlots > 0) {
            canPurchase = false;
            reason = 'User sudah memiliki slot premium';
          }
          break;
          
        case 'additional_slot':
          if (userData.premium.totalSlots === 0) {
            canPurchase = false;
            reason = 'User belum memiliki slot premium, harus beli first_slot dulu';
          }
          break;
          
        case 'renewal':
          if (userData.premium.totalSlots === 0) {
            canPurchase = false;
            reason = 'User belum memiliki slot premium';
          }
          break;
      }

      // Calculate price
      let price;
      switch (paymentType) {
        case 'first_slot':
          price = PAYMENT_CONFIG.FIRST_SLOT_PRICE;
          break;
        case 'additional_slot':
          price = PAYMENT_CONFIG.ADDITIONAL_SLOT_PRICE;
          break;
        case 'renewal':
          const totalSlots = userData.premium.totalSlots || 1;
          price = PAYMENT_CONFIG.FIRST_SLOT_PRICE + 
            ((totalSlots - 1) * PAYMENT_CONFIG.ADDITIONAL_SLOT_PRICE);
          break;
      }

      return {
        canPurchase,
        reason,
        price,
        currentSlots: userData.premium.totalSlots,
        premiumExpiry: userData.premium.expiry
      };
    } catch (error) {
      console.error('Error getting payment info:', error);
      return {
        canPurchase: false,
        reason: 'Error checking user data',
        price: 0,
        currentSlots: 0,
        premiumExpiry: null
      };
    }
  }

  // Check all pending payments (for background checker)
  async checkAllPendingPayments() {
    try {
      const successfulPayments = [];
      
      for (const [transactionId, transaction] of this.pendingTransactions.entries()) {
        try {
          const result = await this.checkPaymentStatus(transactionId);
          if (result.status === 'paid') {
            successfulPayments.push(transaction);
          }
        } catch (error) {
          console.error(`Error checking transaction ${transactionId}:`, error);
        }
      }

      return successfulPayments;
    } catch (error) {
      console.error('Error checking all pending payments:', error);
      return [];
    }
  }

  // Get pricing info
  static getPricing() {
    return {
      firstSlot: PAYMENT_CONFIG.FIRST_SLOT_PRICE,
      additionalSlot: PAYMENT_CONFIG.ADDITIONAL_SLOT_PRICE,
      duration: PAYMENT_CONFIG.PREMIUM_DURATION_DAYS,
      timeout: PAYMENT_CONFIG.PAYMENT_TIMEOUT / (60 * 1000) // In minutes
    };
  }
}

module.exports = { PremiumPaymentManager, PAYMENT_CONFIG };