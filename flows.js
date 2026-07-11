// flows.js
// The category tree, as plain data. Each node is either:
//   - a leaf: { id, label, fields: [{ key, prompt, label }, ...] }
//   - a branch: { id, label, subMenu: { prompt, options: [...] } }
// The state machine in index.js walks this tree generically - it never
// hardcodes category names or question order. To add a question to an
// existing category, add one object to its `fields` array. To add a whole
// new category, copy one block below and add matching entries to
// translations.js. No changes to index.js are needed for either.

module.exports = {
  categories: [
    {
      id: 'flight_booking',
      label: 'flightBookingLabel',
      fields: [
        { key: 'route', prompt: 'askRoute', label: 'routeLabel' },
        { key: 'travelDate', prompt: 'askTravelDate', label: 'travelDateLabel' },
        { key: 'passengers', prompt: 'askPassengers', label: 'passengersLabel' },
      ],
    },
    {
      id: 'booking_inquiry',
      label: 'bookingInquiryLabel',
      fields: [
        { key: 'pnr', prompt: 'askPnr', label: 'pnrLabel' },
        { key: 'issueDescription', prompt: 'askIssueDescription', label: 'issueDescriptionLabel' },
      ],
    },
    {
      id: 'tourism',
      label: 'tourismLabel',
      subMenu: {
        prompt: 'askTourismSubType',
        options: [
          {
            id: 'hotel_only',
            label: 'hotelOnlyLabel',
            fields: [
              { key: 'destination', prompt: 'askDestination', label: 'destinationLabel' },
              { key: 'checkIn', prompt: 'askCheckIn', label: 'checkInLabel' },
              { key: 'checkOut', prompt: 'askCheckOut', label: 'checkOutLabel' },
              { key: 'guests', prompt: 'askGuests', label: 'guestsLabel' },
            ],
          },
          {
            id: 'tour_package',
            label: 'tourPackageLabel',
            fields: [
              { key: 'destination', prompt: 'askDestination', label: 'destinationLabel' },
              { key: 'travelDates', prompt: 'askTravelDates', label: 'travelDatesLabel' },
              { key: 'travelers', prompt: 'askTravelers', label: 'travelersLabel' },
            ],
          },
        ],
      },
    },
    {
      id: 'insurance',
      label: 'insuranceLabel',
      fields: [
        { key: 'travelDate', prompt: 'askTravelDate', label: 'travelDateLabel' },
        { key: 'age', prompt: 'askAge', label: 'ageLabel' },
        { key: 'duration', prompt: 'askDuration', label: 'durationLabel' },
      ],
    },
    {
      id: 'umrah',
      label: 'umrahLabel',
      subMenu: {
        prompt: 'askUmrahSubType',
        options: [
          {
            id: 'umrah_package',
            label: 'umrahPackageLabel',
            fields: [
              { key: 'preferredDates', prompt: 'askPreferredDates', label: 'preferredDatesLabel' },
              { key: 'pilgrims', prompt: 'askPilgrims', label: 'pilgrimsLabel' },
              { key: 'packageTier', prompt: 'askPackageTier', label: 'packageTierLabel' },
            ],
          },
          {
            id: 'visa_only',
            label: 'visaOnlyLabel',
            subMenu: {
              prompt: 'askVisaDuration',
              options: [
                {
                  id: 'visa_15d',
                  label: 'visa15dLabel',
                  fields: [
                    { key: 'destinationCountry', prompt: 'askDestinationCountry', label: 'destinationCountryLabel' },
                    { key: 'travelDate', prompt: 'askTravelDate', label: 'travelDateLabel' },
                  ],
                },
                {
                  id: 'visa_1m',
                  label: 'visa1mLabel',
                  fields: [
                    { key: 'destinationCountry', prompt: 'askDestinationCountry', label: 'destinationCountryLabel' },
                    { key: 'travelDate', prompt: 'askTravelDate', label: 'travelDateLabel' },
                  ],
                },
                {
                  id: 'visa_3m',
                  label: 'visa3mLabel',
                  fields: [
                    { key: 'destinationCountry', prompt: 'askDestinationCountry', label: 'destinationCountryLabel' },
                    { key: 'travelDate', prompt: 'askTravelDate', label: 'travelDateLabel' },
                  ],
                },
              ],
            },
          },
          {
            id: 'scheduled_trip',
            label: 'scheduledTripLabel',
            fields: [
              { key: 'scheduledTripName', prompt: 'askScheduledTripName', label: 'scheduledTripNameLabel' },
              { key: 'travelers', prompt: 'askTravelers', label: 'travelersLabel' },
            ],
          },
          {
            id: 'transport',
            label: 'transportLabel',
            fields: [
              { key: 'pickupLocation', prompt: 'askPickupLocation', label: 'pickupLocationLabel' },
              { key: 'dropoffLocation', prompt: 'askDropoffLocation', label: 'dropoffLocationLabel' },
              { key: 'dateTime', prompt: 'askDateTime', label: 'dateTimeLabel' },
              { key: 'passengers', prompt: 'askPassengers', label: 'passengersLabel' },
            ],
          },
        ],
      },
    },
    {
      id: 'other',
      label: 'otherLabel',
      fields: [
        { key: 'description', prompt: 'askOtherDescription', label: 'otherDescriptionLabel' },
      ],
    },
  ],
};