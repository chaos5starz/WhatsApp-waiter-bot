// translations.js
// Every bot-facing string, keyed by id, with an `en` and `ar` version.
// The state machine in index.js looks strings up here via t(key, lang) -
// nothing customer-facing should ever be hardcoded directly in index.js,
// so a missing translation is easy to spot (just grep this file).
//
// {placeholders} like {name} and {company} are filled in at runtime via
// simple string replacement in index.js - see the t() helper.

module.exports = {
  // ---- General flow ----
  askName: {
    en: `Welcome to {company}! ✈️\nI'll grab a few details before connecting you with our team.\n\nWhat's your name?`,
    ar: `أهلاً بك في {company}! ✈️\nسأقوم بجمع بعض التفاصيل قبل تحويلك إلى فريقنا.\n\nما اسمك؟`,
  },
  menuIntro: {
    en: `Thanks, {name}! How can we help you today?\nPlease reply with a number:`,
    ar: `شكرًا، {name}! كيف يمكننا مساعدتك اليوم؟\nيرجى الرد برقم:`,
  },
  invalidChoice: {
    en: `Sorry, that's not a valid option. Please reply with one of the numbers shown above.`,
    ar: `عذرًا، هذا ليس خيارًا صحيحًا. يرجى الرد بأحد الأرقام الموضحة أعلاه.`,
  },
  confirmIntro: {
    en: `Please confirm your request:`,
    ar: `يرجى تأكيد طلبك:`,
  },
  confirmPrompt: {
    en: `Reply YES to confirm, or NO to start over.`,
    ar: `أرسل "نعم" للتأكيد، أو "لا" للبدء من جديد.`,
  },
  confirmAccepted: {
    en: `Thank you! ✅ Your request has been received — a team member will follow up with you shortly.`,
    ar: `شكرًا لك! ✅ تم استلام طلبك - سيتواصل معك أحد أعضاء فريقنا قريبًا.`,
  },
  confirmRestart: {
    en: `No problem, let's start over. What's your name?`,
    ar: `لا مشكلة، لنبدأ من جديد. ما اسمك؟`,
  },
  nameLabel: {
    en: `Name`,
    ar: `الاسم`,
  },
  farewell: {
    en: `Thank you for contacting {company}! If you need anything else, feel free to reach out anytime. Have a great day! 😊`,
    ar: `شكرًا لتواصلك مع {company}! إذا احتجت أي شيء آخر، لا تتردد في التواصل معنا في أي وقت. نتمنى لك يومًا سعيدًا! 😊`,
  },

  // ---- Top-level category labels ----
  flightBookingLabel: { en: `Flight ticket booking`, ar: `حجز تذاكر طيران` },
  bookingInquiryLabel: { en: `Booking inquiry`, ar: `استفسار عن حجز` },
  tourismLabel: { en: `Tourism & Hotels`, ar: `سياحة وحجز فنادق` },
  insuranceLabel: { en: `Travel health insurance`, ar: `تأمين صحي للمسافرين` },
  umrahLabel: { en: `Umrah trips`, ar: `رحلات العمرة` },
  otherLabel: { en: `Other services`, ar: `خدمات أخرى` },

  // ---- Tourism sub-menu ----
  askTourismSubType: { en: `Would you like:`, ar: `هل ترغب في:` },
  hotelOnlyLabel: { en: `Hotel booking only`, ar: `حجز فندق فقط` },
  tourPackageLabel: { en: `Full tour package`, ar: `باقة سياحية كاملة` },

  // ---- Umrah sub-menu ----
  askUmrahSubType: { en: `Please choose:`, ar: `يرجى الاختيار:` },
  umrahPackageLabel: { en: `Full Umrah package`, ar: `باقة عمرة كاملة` },
  visaOnlyLabel: { en: `Visa only`, ar: `فيزا فقط` },
  scheduledTripLabel: { en: `Scheduled group trip`, ar: `رحلة معلنة` },
  transportLabel: { en: `Transport booking`, ar: `حجز نقل` },

  // ---- Visa duration sub-menu ----
  askVisaDuration: { en: `Please choose the visa duration:`, ar: `يرجى اختيار مدة الفيزا:` },
  visa15dLabel: { en: `15 days`, ar: `15 يومًا` },
  visa1mLabel: { en: `1 month`, ar: `شهر واحد` },
  visa3mLabel: { en: `3 months`, ar: `3 أشهر` },

  // ---- Field prompts & confirmation labels ----
  askRoute: { en: `What are your origin and destination? (e.g. Cairo to Dubai)`, ar: `ما هي نقطة الانطلاق والوجهة؟ (مثال: القاهرة إلى دبي)` },
  routeLabel: { en: `Route`, ar: `المسار` },

  askTravelDate: { en: `What is your preferred travel date?`, ar: `ما هو تاريخ السفر المفضل لديك؟` },
  travelDateLabel: { en: `Travel date`, ar: `تاريخ السفر` },

  askPassengers: { en: `How many passengers?`, ar: `كم عدد المسافرين؟` },
  passengersLabel: { en: `Passengers`, ar: `عدد المسافرين` },

  askPnr: { en: `What is your booking reference (PNR) or ticket number?`, ar: `ما هو رقم الحجز (PNR) أو رقم التذكرة؟` },
  pnrLabel: { en: `Booking ref / Ticket #`, ar: `رقم الحجز / رقم التذكرة` },

  askIssueDescription: { en: `Please describe your inquiry.`, ar: `يرجى وصف استفسارك.` },
  issueDescriptionLabel: { en: `Inquiry details`, ar: `تفاصيل الاستفسار` },

  askDestination: { en: `What is your destination city?`, ar: `ما هي مدينة الوجهة؟` },
  destinationLabel: { en: `Destination`, ar: `الوجهة` },

  askCheckIn: { en: `What is your check-in date?`, ar: `ما هو تاريخ الوصول؟` },
  checkInLabel: { en: `Check-in date`, ar: `تاريخ الوصول` },

  askCheckOut: { en: `What is your check-out date?`, ar: `ما هو تاريخ المغادرة؟` },
  checkOutLabel: { en: `Check-out date`, ar: `تاريخ المغادرة` },

  askGuests: { en: `How many guests?`, ar: `كم عدد النزلاء؟` },
  guestsLabel: { en: `Guests`, ar: `عدد النزلاء` },

  askTravelDates: { en: `What are your preferred travel dates?`, ar: `ما هي تواريخ السفر المفضلة لديك؟` },
  travelDatesLabel: { en: `Travel dates`, ar: `تواريخ السفر` },

  askTravelers: { en: `How many travelers?`, ar: `كم عدد المسافرين؟` },
  travelersLabel: { en: `Travelers`, ar: `عدد المسافرين` },

  askAge: { en: `What is your age?`, ar: `كم عمرك؟` },
  ageLabel: { en: `Age`, ar: `العمر` },

  askDuration: { en: `What is the trip duration?`, ar: `ما هي مدة الرحلة؟` },
  durationLabel: { en: `Duration`, ar: `المدة` },

  askPreferredDates: { en: `What are your preferred dates for the trip?`, ar: `ما هي التواريخ المفضلة للرحلة؟` },
  preferredDatesLabel: { en: `Preferred dates`, ar: `التواريخ المفضلة` },

  askPilgrims: { en: `How many pilgrims will be traveling?`, ar: `كم عدد المعتمرين المسافرين؟` },
  pilgrimsLabel: { en: `Pilgrims`, ar: `عدد المعتمرين` },

  askPackageTier: { en: `Which package would you prefer? (e.g. Economy, Standard, VIP)`, ar: `ما هي الباقة التي تفضلها؟ (اقتصادية، عادية، VIP)` },
  packageTierLabel: { en: `Package tier`, ar: `فئة الباقة` },

  askDestinationCountry: { en: `Which country is the visa for?`, ar: `ما هي الدولة المطلوب لها الفيزا؟` },
  destinationCountryLabel: { en: `Visa country`, ar: `دولة الفيزا` },

  askScheduledTripName: { en: `Which scheduled trip are you interested in, or what destination?`, ar: `ما هي الرحلة المعلنة التي تهمك، أو ما هي الوجهة؟` },
  scheduledTripNameLabel: { en: `Trip / destination`, ar: `الرحلة / الوجهة` },

  askPickupLocation: { en: `What is the pickup location?`, ar: `ما هو موقع الانطلاق؟` },
  pickupLocationLabel: { en: `Pickup location`, ar: `موقع الانطلاق` },

  askDropoffLocation: { en: `What is the drop-off location?`, ar: `ما هو موقع الوصول؟` },
  dropoffLocationLabel: { en: `Drop-off location`, ar: `موقع الوصول` },

  askDateTime: { en: `What date and time do you need the transport?`, ar: `ما هو التاريخ والوقت المطلوب للنقل؟` },
  dateTimeLabel: { en: `Date & time`, ar: `التاريخ والوقت` },

  askOtherDescription: { en: `Please describe what you need help with.`, ar: `يرجى وصف ما تحتاج المساعدة فيه.` },
  otherDescriptionLabel: { en: `Details`, ar: `التفاصيل` },
};