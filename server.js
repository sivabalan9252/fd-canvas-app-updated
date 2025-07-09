require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const bodyParser = require('body-parser');
const {
  fetchIntercomConversation,
  formatConversationAsHtml,
  addConversationTranscriptToTicket,
  createFreshdeskTicket,
  downloadFile
} = require('./conversation-helper.js');

const app = express();

// --- HELPER FUNCTIONS ---

// Builds the UI components for the recent tickets list to ensure consistent styling.
function buildRecentTicketsComponent(tickets, showLoadMore = false) {
  const components = [];
  if (tickets && tickets.length > 0) {
    components.push({ type: 'spacer', size: 'l' });
    components.push({ type: 'text', text: 'Recent Tickets', style: 'header', align: 'left', color: 'white' });
    components.push({ type: 'spacer', size: 'xs' });

    tickets.forEach((ticket) => {
      const createdDate = new Date(ticket.created_at);
      const formattedDate = createdDate.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

      const [datePart, timePart] = formattedDate.split(', ');
      const [time, period] = timePart.split(' ');
      const formattedTime = `${time} ${period.toUpperCase()}`;

      let displaySubject = ticket.subject;
      if (displaySubject.length > 40) {
        displaySubject = displaySubject.substring(0, 40) + '...';
      }

      components.push({
        type: 'text',
        id: `ticket_${ticket.id}`,
        text: `[#${ticket.id} - ${displaySubject}](${FRESHDESK_DOMAIN}/a/tickets/${ticket.id})`,
        style: 'muted',
      });

      components.push({
        type: 'text',
        id: `ticket_date_${ticket.id}`,
        text: `${datePart}, ${formattedTime}`,
        style: 'muted',
        size: 'small',
      });

      components.push({ type: 'spacer', size: 'xs' });
    });
    
    // Add Load More button if requested
    if (showLoadMore) {
      components.push({ type: 'spacer', size: 'm' });
      components.push({
        type: 'button',
        id: 'load_more_home_tickets',
        label: 'Load More Tickets',
        style: 'secondary',
        action: {
          type: 'submit'
        }
      });
    }
  } else {
    components.push({ type: 'spacer', size: 'l' });
    components.push({ type: 'text', text: 'Recent Tickets', style: 'header', align: 'left', color: 'white' });
    components.push({ type: 'spacer', size: 'xs' });
    components.push({ type: 'text', text: 'No recent tickets found for this user.', style: 'muted' });
  }
  return components;
}

// Helper function to fetch recent tickets from Freshdesk
async function fetchRecentTickets(email) {
  if (!email) return [];
  try {
    const response = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(email)}&per_page=5&order_by=created_at&order_type=desc`, {
      auth: { username: FRESHDESK_API_KEY, password: FRESHDESK_PASSWORD },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching recent tickets from Freshdesk:', error.response ? error.response.data : error.message);
    return []; // Return empty array on error
  }
}

const PORT = 3001;

// In-memory store for tracking in-progress tickets
// Key: email, Value: { inProgress: boolean, ticketId: number (if created) }
const ticketTracker = new Map();

// Freshdesk API configuration
const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;
const FRESHDESK_PASSWORD = process.env.FRESHDESK_PASSWORD;

// Base64 encode the API key and password for Basic Auth
// Base64 auth is handled within the createFreshdeskTicket function

// Increase request size limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(bodyParser.json());

// Enhanced CORS configuration to handle React development server requests and ngrok
app.use(cors({
  origin: '*', // Allow all origins for development
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Origin']
}));

// Add specific CORS headers for all responses
app.use((req, res, next) => {
  // Log the request origin for debugging
  console.log('Request origin:', req.headers.origin);
  
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', '*'); // Allow all origins
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Simple request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Simple test endpoint
app.get('/api/health', (req, res) => {
  console.log('Health check received');
  res.json({ status: 'ok', message: 'Server is running' });
});

// Process Intercom context and initialize canvas with direct rendering
app.post('/api/initialize', async (req, res) => {
  console.log('Initializing canvas...', new Date().toISOString());
  console.log('Request body keys:', Object.keys(req.body));
  
  try {
    // Extract useful information from Intercom's initialization request
    const conversation = req.body.conversation || {};
    const customer = req.body.customer || {};
    const contact = req.body.contact || {};
    
    // Try multiple possible locations for the email
    const customerEmail = customer.email || 
                         contact.email || 
                         (conversation.contact ? conversation.contact.email : '') || '';
                         
    // Always clear any in-progress tickets when Canvas is initialized
    if (customerEmail && ticketTracker.has(customerEmail)) {
      const ticketInfo = ticketTracker.get(customerEmail);
      // Only keep completed tickets in the tracker
      if (ticketInfo.inProgress) {
        console.log(`Clearing in-progress ticket state for ${customerEmail} during initialization`);
        ticketTracker.delete(customerEmail);
      }
    }
    
    // Get contact name from contact or customer object
    const contactName = contact.name || customer.name || '';
    
    // Always use 'Conversation from [Contact Name]' as the subject
    const defaultTitle = contactName ? `Conversation from ${contactName}` : 'New Conversation';
                         
    const defaultDescription = (conversation.custom_attributes ? conversation.custom_attributes.default_description : '') || 
                              (conversation.source ? conversation.source.body : '') || 
                              '';
    
    console.log('Customer email:', customerEmail);
    console.log('Default title:', defaultTitle);
    console.log('Default description:', defaultDescription);
    
    // Store context data in app.locals for later use in submit endpoint
    app.locals.intercomContext = {
      customerEmail,
      defaultTitle,
      defaultDescription
    };
    
    // Initialize home page pagination state
    app.locals.homePageState = {
      customerEmail: customerEmail,
      currentOffset: 0,
      allTickets: [],
      hasMore: true
    };

    // Fetch first 20 tickets from Freshdesk to see if there are more
    const ticketsResponse = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(customerEmail)}&order_by=created_at&order_type=desc&per_page=20&page=1`, {
      auth: {
        username: FRESHDESK_API_KEY,
        password: FRESHDESK_PASSWORD
      }
    });

    const allTickets = ticketsResponse.data;
    console.log(`Initial home page - Fetched ${allTickets.length} tickets total`);
    
    // Store all tickets in app.locals, but show only first 5
    app.locals.homePageState.allTickets = allTickets;
    app.locals.homePageState.currentOffset = 5;
    app.locals.homePageState.hasMore = allTickets.length > 5;
    
    console.log(`Home page state - Total tickets: ${app.locals.homePageState.allTickets.length}, Has more: ${app.locals.homePageState.hasMore}`);
    
    // Show only first 5 tickets initially
    const recentTickets = allTickets.slice(0, 5);
    
    // Following the Intercom Inbox App documentation format exactly
    // Create a simplified Canvas response that strictly follows Intercom format
    // Start with just the create ticket button
    const components = [];
    
    // Add spacing before the create ticket button
    components.push({
      type: 'spacer',
      size: 'm'
    });
    
    // Always show the create ticket button (no in-progress state in the UI)
    components.push({
      type: 'button',
      id: 'create_ticket',
      label: 'Create a Freshdesk Ticket',
      style: 'primary',
      action: {
        type: 'submit'
      }
    });

    // Add a spacer
    components.push({
      type: 'spacer',
      size: 's'
    });

    // Add the 'Add to existing ticket' button
    components.push({
      type: 'button',
      id: 'add_to_existing_ticket',
      label: 'Add to existing Freshdesk Ticket',
      style: 'secondary',
      action: {
        type: 'submit'
      }
    });

    // Add spacing between button and Recent Tickets header
    components.push({
      type: 'spacer',
      size: 'l'
    });

    // Build and add the recent tickets component with load more button if needed
    const recentTicketsComponent = buildRecentTicketsComponent(recentTickets, app.locals.homePageState.hasMore);
    components.push(...recentTicketsComponent);

    // Create the response object with the exact structure Intercom expects
    const response = {
      canvas: {
        content: {
          components: components
        }
      }
    };
    
    console.log('Sending initial response to Intercom');
    res.json(response);
  } catch (error) {
    console.error('Error processing Intercom context:', error);
    // Return an error response
    res.json({
      canvas: {
        content: {
          components: [
            {
              type: 'text',
              id: 'error',
              text: 'Error loading Freshdesk integration. Please try again.',
              align: 'center',
              style: 'header'
            }
          ]
        }
      }
    });
  }
});

// Serve static files (React build) if the build directory exists
if (require('fs').existsSync(path.join(__dirname, 'build'))) {
  app.use(express.static(path.join(__dirname, 'build')));
  
  // Catch-all handler for UI routes only
  app.get('/ui/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
}

// Freshdesk API Endpoints

// No mock data needed for production use - using real Freshdesk API

// Helper function to post a note to Intercom conversation
async function postIntercomNote(conversationId, noteBody) {
  try {
    console.log(`Posting note to Intercom conversation ${conversationId}`);
    const response = await axios.post(
      `${process.env.INTERCOM_API_URL}/conversations/${conversationId}/reply`,
      {
        message_type: 'note',
        type: 'admin',
        admin_id: parseInt(process.env.INTERCOM_ADMIN_ID, 10), // Admin ID from environment variable
        body: noteBody
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.INTERCOM_ACCESS_TOKEN}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Intercom note posted successfully');
    return response.data;
  } catch (error) {
    console.error('Error posting note to Intercom:', error.response?.data || error.message);
    return null;
  }
}

// Helper function to make API calls with retry
async function fetchWithRetry(url, options = {}, retries = 3, initialDelay = 500) {
  let currentDelay = initialDelay;
  let attempts = 0;
  
  // Add default method if not specified
  options.method = options.method || 'GET';
  
  // Ensure headers object exists
  options.headers = options.headers || {};
  
  // Add Freshdesk API auth for all calls if needed
  if (!options.auth && url.includes(FRESHDESK_DOMAIN)) {
    options.auth = {
      username: FRESHDESK_API_KEY,
      password: FRESHDESK_PASSWORD
    };
  }
  
  // Configure axios options
  if (options.data) {
    options.headers['Content-Type'] = 'application/json';
  }
  
  while (attempts <= retries) {
    try {
      console.log(`Attempt ${attempts + 1} for ${url}`);
      const response = await axios({
        url,
        ...options,
        timeout: 10000 // 10 second timeout
      });
      return response;
    } catch (error) {
      attempts++;
      
      if (attempts > retries) {
        console.error(`All ${retries + 1} attempts failed for ${url}`);
        throw error;
      }
      
      console.log(`Attempt ${attempts} failed, retrying in ${currentDelay}ms...`);
      
      // Use a local variable to safely capture the current delay value
      const delayForThisAttempt = currentDelay;
      await new Promise(resolve => setTimeout(resolve, delayForThisAttempt));
      
      // Exponential backoff with jitter
      currentDelay = Math.min(currentDelay * 2, 10000) * (0.8 + Math.random() * 0.4);
    }
  }
}

// Helper functions for Intercom conversation are imported from conversation-helper.js

// Get mailboxes from Freshdesk
app.get('/api/freshdesk/mailboxes', async (req, res) => {
  try {
    console.log('Fetching mailboxes from Freshdesk...');
    
    const response = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/email/mailboxes`, { method: 'GET' });
    
    console.log('Mailboxes response received');
    
    // Filter only the needed fields for each mailbox
    const mailboxes = response.data.map(mailbox => ({
      id: mailbox.id,
      name: mailbox.name,
      support_email: mailbox.support_email,
      product_id: mailbox.product_id
    }));
    
    res.json(mailboxes);
  } catch (error) {
    console.error('Error fetching mailboxes:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch mailboxes from Freshdesk', details: error.message });
  }
});

// Get recent tickets from Freshdesk
app.get('/api/freshdesk/recent-tickets', async (req, res) => {
  try {
    console.log('Fetching recent tickets from Freshdesk...');
    
    // Get customer email from query params or from app.locals
    const customerEmail = req.query.email || app.locals.intercomContext?.customerEmail;
    
    if (!customerEmail) {
      return res.status(400).json({ error: 'Customer email is required' });
    }
    
    // Fetch tickets from Freshdesk API
    const response = await fetchWithRetry(
      `${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(customerEmail)}&order_by=created_at&order_type=desc&per_page=5`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(FRESHDESK_API_KEY + ':' + FRESHDESK_PASSWORD).toString('base64')
        }
      }
    );
    
    // Extract relevant ticket information
    const tickets = response.data.map(ticket => ({
      id: ticket.id,
      subject: ticket.subject,
      created_at: ticket.created_at
    }));
    
    res.json(tickets);
  } catch (error) {
    console.error('Error fetching recent tickets:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch recent tickets from Freshdesk', details: error.message });
  }
});

// Get ticket statuses from Freshdesk
app.get('/api/freshdesk/statuses', async (req, res) => {
  try {
    console.log('Fetching statuses from Freshdesk...');
    
    // First get the field ID for status
    const fieldsResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields`, { method: 'GET' });
    
    // Find the status field
    const statusField = fieldsResponse.data.find(field => field.name === 'status');
    
    if (!statusField) {
      throw new Error('Status field not found');
    }
    
    console.log('Status field ID:', statusField.id);
    
    // Get the choices for the status field
    const statusChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${statusField.id}`, { method: 'GET' });
    
    // Map the choices to a simpler format
    const statuses = statusChoicesResponse.data.choices.map(choice => ({
      id: choice.id,
      label: choice.label
    }));
    
    console.log('Status choices received');
    res.json(statuses);
  } catch (error) {
    console.error('Error fetching statuses:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch statuses from Freshdesk' });
  }
});

// Note: '/api/freshdesk/recent-tickets' endpoint is already defined above

// Get ticket priorities from Freshdesk
app.get('/api/freshdesk/priorities', async (req, res) => {
  try {
    console.log('Fetching priorities from Freshdesk...');
    
    // First get the field ID for priority
    const fieldsResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields`, { method: 'GET' });
    
    // Find the priority field
    const priorityField = fieldsResponse.data.find(field => field.name === 'priority');
    
    if (!priorityField) {
      throw new Error('Priority field not found');
    }
    
    console.log('Priority field ID:', priorityField.id);
    
    // Get the choices for the priority field
    const priorityChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${priorityField.id}`, { method: 'GET' });
    
    console.log('Priority choices received');
    // Return the priority choices
    res.json(priorityChoicesResponse.data.choices);
  } catch (error) {
    console.error('Error fetching priorities:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch priorities from Freshdesk' });
  }
});

// Create a ticket in Freshdesk
app.post('/api/freshdesk/create-ticket', async (req, res) => {
  console.log('Creating ticket in Freshdesk...');
  console.log('Request body:', req.body);
  
  try {
    // Extract ticket data from request body
    const { email, subject, description, status, priority } = req.body;
    
    // Get conversation ID from the request
    const conversationId = req.body.conversation_id || req.body.conversation?.id;
    
    // Validate required fields
    if (!email || !subject || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Prepare the base ticket data
    let ticketData = {
      email,
      subject,
      description,
      source: 2 // Web form
    };
    
    // Add optional fields if they exist
    if (status) ticketData.status = parseInt(status, 10);
    if (priority) ticketData.priority = parseInt(priority, 10);
    
    // Add conversation ID to ticket data
    if (conversationId) {
      ticketData._intercom_conversation_id = conversationId;
      
      try {
        console.log(`Adding conversation transcript for ID: ${conversationId}`);
        ticketData = await addConversationTranscriptToTicket(ticketData, conversationId);
      } catch (transcriptError) {
        console.error('Error adding conversation transcript:', transcriptError);
        // Continue with ticket creation even if transcript fails
      }

      // Add Intercom URL directly to the description in the exact format requested
      const intercomUrl = `${process.env.INTERCOM_INBOX_URL}/conversation/${conversationId}`;
      const urlSection = `Chat Transcript Added\n\nIntercom Conversation URL: ${intercomUrl}\n\n`;
      
      console.log('Adding Intercom URL to ticket description:', urlSection);
      
      // Add URL section at the beginning of the description
      if (ticketData.description && ticketData.description.includes('Chat Transcript Added')) {
        ticketData.description = ticketData.description.replace('Chat Transcript Added', urlSection.trim());
      } else {
        ticketData.description = urlSection + (ticketData.description || '');
      }
    }
    
    // Create ticket in Freshdesk
    console.log('Creating Freshdesk ticket with data:', JSON.stringify(ticketData, null, 2));
    const ticket = await createFreshdeskTicket(ticketData);
    console.log('Ticket created successfully:', JSON.stringify(ticket, null, 2));
    
    // Return success response without the success message
    res.json({
      success: true,
      ticket: ticket
    });
  } catch (error) {
    console.error('Error creating ticket:', error.response?.data || error.message);
    
    // Return error response
    res.status(500).json({
      error: 'Failed to create ticket',
      details: error.response?.data || error.message
    });
  }
});

// Handle Intercom Canvas form submissions
app.post('/api/submit', async (req, res) => {
  console.log('Received form submission from Intercom Canvas:', req.body);
  
  // Create a flag to track if response has been sent
  let responseSent = false;
  
  // Set a timeout to return to homepage before Intercom's 10-second timeout
  const timeoutId = setTimeout(async () => {
    if (!responseSent) {
      console.log('⏰ TIMEOUT: Forcing return to homepage before Intercom timeout occurs');
      responseSent = true;
      
      // Track this ticket as in-progress
      const email = req.body.contact?.email || req.body.customer?.email || app.locals.intercomContext?.customerEmail;
      if (email && req.body.component_id === 'submit_ticket_button') {
        ticketTracker.set(email, {
          inProgress: true,
          startedAt: new Date().toISOString()
        });
        console.log(`Tracked in-progress ticket for ${email}`);
      }
      
      // Create components array for normal homepage view
      const components = [
        {
          type: 'button',
          id: 'create_ticket',
          label: 'Create a Freshdesk Ticket',
          style: 'primary',
          action: {
            type: 'submit'
          }
        },
        {
          type: 'divider'
        },
        {
          type: 'text',
          id: 'recent_tickets_header',
          text: 'Recent Tickets',
          style: 'header'
        }
      ];
      
      // Try to get recent tickets
      try {
        if (email) {
          // Fetch recent tickets from Freshdesk API
          const ticketsResponse = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(email)}&order_by=created_at&order_type=desc&per_page=5`, {
            auth: {
              username: FRESHDESK_API_KEY,
              password: FRESHDESK_PASSWORD
            },
            headers: {
              'Content-Type': 'application/json'
            }
          });
          
          if (ticketsResponse.data && ticketsResponse.data.length > 0) {
            // Process each ticket and add to components
            ticketsResponse.data.forEach(ticket => {
              // Format the date
              const ticketDate = new Date(ticket.created_at);
              
              // Format date to DD/MM/YYYY and time in IST with AM/PM
              const formattedTicketDate = ticketDate.toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
              });
              
              // Split into date and time parts
              const dateParts = formattedTicketDate.split(', ');
              const datePart = dateParts[0];
              const formattedTime = dateParts[1];
              
              // Truncate subject if too long
              let displaySubject = ticket.subject;
              if (displaySubject.length > 40) {
                displaySubject = displaySubject.substring(0, 40) + '...';
              }
              
              // Add ticket information as a text component
              components.push({
                type: 'text',
                id: `ticket_${ticket.id}`,
                text: `[#${ticket.id} - ${displaySubject}](${FRESHDESK_DOMAIN}/a/tickets/${ticket.id})`,
                style: 'muted'
              });
              
              // Add date on a new line
              components.push({
                type: 'text',
                id: `ticket_date_${ticket.id}`,
                text: `${datePart}, ${formattedTime}`,
                style: 'muted',
                size: 'small'
              });
              
              // Add a small spacer after each ticket for better separation
              components.push({
                type: 'spacer',
                size: 'xs'
              });
            });
          } else {
            // No tickets found
            components.push({
              type: 'text',
              id: 'no_tickets',
              text: 'No recent tickets',
              style: 'muted'
            });
          }
        } else {
          // No email available
          components.push({
            type: 'text',
            id: 'no_tickets',
            text: 'No recent tickets',
            style: 'muted'
          });
        }
      } catch (error) {
        console.error('Error fetching recent tickets on timeout:', error);
        components.push({
          type: 'text',
          id: 'no_tickets',
          text: 'No recent tickets',
          style: 'muted'
        });
      }
      
      // Return the standard homepage view with recent tickets
      if (!responseSent) {
        res.json({
          canvas: {
            content: {
              components: components
            }
          }
        });
        responseSent = true;
      }
    }
  }, 9000); // Exactly 9 seconds - to ensure we return before Intercom's 10-second timeout

  // Helper function to safely send response and avoid duplicate responses
  const sendResponse = (responseData) => {
    if (!responseSent) {
      res.json(responseData);
      responseSent = true;
      clearTimeout(timeoutId); // This is correct now
      console.log('Response sent to Intercom.');
    } else {
      console.log('Attempted to send response, but one was already sent.');
    }
  };

  try {
    // Get contact name from the request body
    const contactName = req.body.contact?.name || req.body.customer?.name || 'Contact';
    const defaultTitle = `Conversation from ${contactName}`;

    // Get customer email from the request body
    const customerEmail = req.body.contact?.email || req.body.customer?.email || '';
    
    // Get default description from conversation or use empty string
    const defaultDescription = req.body.conversation?.source?.body || '';
    
    // Log the values being used
    console.log('Using customer email:', customerEmail);
    console.log('Using default title:', defaultTitle);
    console.log('Using default description:', defaultDescription);
    
    // Store in app.locals for potential future use
    app.locals.intercomContext = {
      customerEmail,
      defaultTitle,
      defaultDescription
    };
    
    if (req.body.component_id === 'create_ticket') {
      // Initial button click - show the form
      console.log('Create ticket button clicked, showing form...');
      
      // Fetch Freshdesk data for the form
      let mailboxes = [];
      let statusField = null;
      let priorityField = null;
      let statusChoices = [];
      let priorityChoices = [];
      
      try {
        console.log('Fetching mailboxes from Freshdesk...');
        // Fetch mailboxes with retry
        const mailboxesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/email/mailboxes`, { method: 'GET' });
        
        console.log('Mailboxes response:', mailboxesResponse.data);
        mailboxes = mailboxesResponse.data;
        
        // Fetch ticket fields with retry
        console.log('Fetching ticket fields from Freshdesk...');
        const fieldsResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields`, { method: 'GET' });
        
        // Find status field
        statusField = fieldsResponse.data.find(field => field.name === 'status');
        if (statusField) {
          console.log('Found status field with ID:', statusField.id);
          const statusChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${statusField.id}`, { method: 'GET' });
          
          statusChoices = statusChoicesResponse.data.choices;
          console.log('Status choices:', statusChoices);
        }
        
        // Find priority field
        priorityField = fieldsResponse.data.find(field => field.name === 'priority');
        if (priorityField) {
          console.log('Found priority field with ID:', priorityField.id);
          const priorityChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${priorityField.id}`, { method: 'GET' });
          
          priorityChoices = priorityChoicesResponse.data.choices;
          console.log('Priority choices:', priorityChoices);
        }
      } catch (error) {
        console.error('Error fetching Freshdesk data:', error.message);
        // Return an error response if we couldn't fetch the required data
        return res.status(500).json({
          canvas: {
            content: {
              components: [
                {
                  type: 'text',
                  text: 'Error',
                  style: 'header'
                },
                {
                  type: 'text',
                  text: 'Failed to load Freshdesk data. Please try again in a moment.',
                  style: 'error'
                },
                {
                  type: 'button',
                  id: 'retry_button',
                  label: 'Retry',
                  style: 'primary',
                  action: {
                    type: 'submit'
                  }
                }
              ]
            }
          }
        });
      }
      
      // Following strictly the format in the Intercom documentation
      // Set default values
      const defaultDescription = 'Chat Transcript Added';
      
      // We'll add inline validation rules directly to the email field

      const formComponents = [
        {
          type: 'text',
          text: 'Create a new Freshdesk ticket',
          style: 'header'
        },
        {
          type: 'input',
          id: 'email',
          label: 'Email',
          value: customerEmail || '',
          placeholder: 'Enter email address',
          validation_rules: {
            required: { error: 'Email is required' },
            format: { type: 'email_address', error: 'Please enter a valid email address' }
          }
        },
        {
          type: 'input',
          id: 'subject',
          label: 'Subject',
          value: defaultTitle || 'New Ticket'
        },
        {
          type: 'textarea',
          id: 'description',
          label: 'Description',
          value: defaultDescription
        }
      ];

      // Add mailboxes dropdown if available
      if (mailboxes && mailboxes.length > 0) {
        // Filter out inactive mailboxes
        const activeMailboxes = mailboxes.filter(mailbox => mailbox.active === true);
        

      }

      // Add status dropdown if available
      if (statusChoices.length > 0) {
        // Find the default status (Open or first available)
        const defaultStatus = statusChoices.find(s => s.label.toLowerCase() === 'open') || statusChoices[0];
        const statusOptions = statusChoices.map(status => ({
          type: 'option',
          id: `status_${status.id}`,
          text: status.label,
          value: status.id.toString()
        }));
        
        formComponents.push({
          type: 'dropdown',
          id: 'status',
          label: 'Status',
          value: defaultStatus ? `status_${defaultStatus.id}` : '',
          options: statusOptions
        });
      }

      // Add priority dropdown if available
      if (priorityChoices.length > 0) {
        // Find the default priority (Medium or first available)
        const defaultPriority = priorityChoices.find(p => p.label.toLowerCase() === 'medium') || priorityChoices[0];
        const priorityOptions = priorityChoices.map(priority => ({
          type: 'option',
          id: `priority_${priority.value}`,
          text: priority.label,
          value: priority.value.toString()
        }));
        
        formComponents.push({
          type: 'dropdown',
          id: 'priority',
          label: 'Priority',
          value: defaultPriority ? `priority_${defaultPriority.value}` : '',
          options: priorityOptions
        });
      }

      // Add action buttons
      formComponents.push(
        {
          type: 'button',
          id: 'submit_ticket_button',
          label: 'Create Ticket',
          style: 'primary',
          disabled: false, // Ensure it's enabled by default
          action: {
            type: 'submit'
          }
        },
        {
          type: 'button',
          id: 'cancel',
          label: 'Cancel',
          style: 'secondary',
          disabled: false, // Ensure it's enabled by default
          action: {
            type: 'submit'
          }
        }
      );

      // Find the selected status and priority values
      const selectedStatus = statusChoices.find(s => s.label.toLowerCase() === 'open') || statusChoices[0];
      const selectedPriority = priorityChoices.find(p => p.label.toLowerCase() === 'medium') || priorityChoices[0];

      // Return the form components with selected values and validation
      sendResponse({
        canvas: {
          content: {
            components: formComponents,
            // Set the selected values in the response
            values: {
              status: selectedStatus ? `status_${selectedStatus.id}` : '',
              priority: selectedPriority ? `priority_${selectedPriority.value}` : ''
            },
            // Add validation rules to ensure the submit button is disabled for invalid forms
            validation_errors: {
              // Make sure email is required for the form to be valid
              email: customerEmail ? '' : 'Email is required'
            }
          }
        }
      });
      return;
    } else if (req.body.component_id === 'add_to_existing_ticket') {
      // Handle 'Add to existing ticket' button click
      console.log('Add to existing ticket button clicked, fetching recent tickets...');

      try {
        const customerEmail = app.locals.intercomContext?.customerEmail || req.body.customer?.email;

        if (!customerEmail) {
          console.error('Customer email not found for fetching recent tickets.');
          return sendResponse({
            canvas: {
              content: {
                components: [
                  { type: 'text', text: 'Could not find customer email to fetch tickets.', align: 'center' },
                  { type: 'button', id: 'cancel', label: 'Back to Home', action: { type: 'submit' } }
                ]
              }
            }
          });
        }

        // Initialize pagination state
        app.locals.mergePageState = {
          customerEmail: customerEmail,
          currentOffset: 0,
          allTickets: [],
          hasMore: true
        };

        // Fetch first 20 tickets from Freshdesk to see if there are more
        const ticketsResponse = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(customerEmail)}&order_by=created_at&order_type=desc&per_page=20&page=1`, {
          auth: {
            username: FRESHDESK_API_KEY,
            password: FRESHDESK_PASSWORD
          }
        });

        const allTickets = ticketsResponse.data;
        console.log(`Initial merge page - Fetched ${allTickets.length} tickets total`);
        console.log('All tickets:', allTickets.map(t => `#${t.id} - ${t.subject}`));
        
        const components = [];

        if (allTickets.length > 0) {
          // Store all tickets in app.locals, but show only first 5
          app.locals.mergePageState.allTickets = allTickets;
          app.locals.mergePageState.currentOffset = 5;
          app.locals.mergePageState.hasMore = allTickets.length > 5; // If we have more than 5, there are more
          
          console.log(`Initial state - Total tickets: ${app.locals.mergePageState.allTickets.length}, Has more: ${app.locals.mergePageState.hasMore}`);
          
          // Show only first 5 tickets initially
          const recentTickets = allTickets.slice(0, 5);

          components.push({
            type: 'text',
            text: 'Select a ticket to merge this conversation into:',
            style: 'header'
          });

          recentTickets.forEach(ticket => {
            components.push({
              type: 'button',
              id: `select_ticket_${ticket.id}`,
              label: `#${ticket.id} - ${ticket.subject}`,
              style: 'secondary',
              action: {
                type: 'submit'
              }
            });
            components.push({ type: 'spacer', size: 's' });
          });
          
          // Add Load More button if there might be more tickets
          if (app.locals.mergePageState.hasMore) {
            components.push({ type: 'spacer', size: 'm' });
            components.push({
              type: 'button',
              id: 'load_more_tickets',
              label: 'Load More Tickets',
              style: 'secondary',
              action: {
                type: 'submit'
              }
            });
          }
          
          // Add back button
          components.push({ type: 'spacer', size: 'm' });
          components.push({
            type: 'button',
            id: 'back_to_home',
            label: 'Back to Home',
            style: 'secondary',
            action: {
              type: 'submit'
            }
          });
        } else {
          components.push({
            type: 'text',
            text: 'No existing tickets found for this user.',
            align: 'center'
          });
          
          // Add back button even when no tickets
          components.push({ type: 'spacer', size: 'm' });
          components.push({
            type: 'button',
            id: 'back_to_home',
            label: 'Back to Home',
            style: 'secondary',
            action: {
              type: 'submit'
            }
          });
        }

        sendResponse({
          canvas: {
            content: {
              components: components
            }
          }
        });

      } catch (error) {
        console.error('Error fetching recent tickets for merging:', error);
        sendResponse({
          canvas: {
            content: {
              components: [
                { type: 'text', text: 'Error fetching recent tickets. Please try again.', align: 'center' },
                { type: 'button', id: 'cancel', label: 'Back to Home', action: { type: 'submit' } }
              ]
            }
          }
        });
      }
    } else if (req.body.component_id && req.body.component_id.startsWith('select_ticket_')) {
      const ticketId = req.body.component_id.replace('select_ticket_', '');
      console.log(`User selected ticket ${ticketId}`);

      // Store the selected ticket ID in the app.locals for later use
      app.locals.selectedTicketId = ticketId;

      const components = [
        {
          type: 'text',
          text: `Merge conversation with Ticket #${ticketId}?`,
          style: 'header',
          align: 'center'
        },
        {
          type: 'button',
          id: 'merge_ticket',
          label: 'Merge',
          style: 'primary',
          action: {
            type: 'submit'
          }
        },
        { type: 'spacer', size: 's' },
        {
          type: 'button',
          id: 'cancel_merge',
          label: 'Cancel',
          style: 'secondary',
          action: {
            type: 'submit'
          }
        }
      ];

      sendResponse({
        canvas: {
          content: {
            components: components
          }
        }
      });

    } else if (req.body.component_id === 'merge_ticket') {
      const ticketId = app.locals.selectedTicketId;
      const conversationId = req.body.conversation.id;

      if (!ticketId || !conversationId) {
        // This case is synchronous, so we can return an immediate error
        sendResponse({
          canvas: {
            content: {
              components: [
                { type: 'text', text: 'Error: Missing ticket or conversation ID.', style: 'header' },
                { type: 'button', id: 'cancel', label: 'Back to Home', style: 'primary' }
              ]
            }
          }
        });
        return;
      }

      // --- UI RESPONSE ---
      // Fetch recent tickets to display on the home screen.
      (async () => {
        try {
          const customerEmail = req.body.contact?.email || req.body.customer?.email || app.locals.intercomContext?.customerEmail;
          let components = [
            { type: 'button', id: 'create_ticket', label: 'Create a Freshdesk Ticket', style: 'primary', action: { type: 'submit' } },
            { type: 'spacer', size: 's' },
            { type: 'button', id: 'add_to_existing_ticket', label: 'Add to existing Freshdesk Ticket', action: { type: 'submit' } }
          ];

          if (customerEmail) {
            // Use home page state if available, otherwise fetch fresh tickets
            if (app.locals.homePageState && app.locals.homePageState.customerEmail === customerEmail) {
              const displayedTickets = app.locals.homePageState.allTickets.slice(0, app.locals.homePageState.currentOffset);
              const recentTicketsComponent = buildRecentTicketsComponent(displayedTickets, app.locals.homePageState.hasMore);
              components.push(...recentTicketsComponent);
            } else {
              const recentTickets = await fetchRecentTickets(customerEmail);
              const recentTicketsComponent = buildRecentTicketsComponent(recentTickets);
              components.push(...recentTicketsComponent);
            }
          }

          sendResponse({
            canvas: {
              content: { components: components }
            }
          });
        } catch (error) {
          console.error('Error fetching recent tickets for home screen:', error);
          // Fallback to simple home screen on error
          sendResponse({
            canvas: {
              content: {
                components: [
                  { type: 'button', id: 'create_ticket', label: 'Create a Freshdesk Ticket', style: 'primary', action: { type: 'submit' } },
                  { type: 'spacer', size: 's' },
                  { type: 'button', id: 'add_to_existing_ticket', label: 'Add to existing Freshdesk Ticket', action: { type: 'submit' } }
                ]
              }
            }
          });
        }
      })();

      // --- BACKGROUND PROCESSING ---
      (async () => {
        try {
          // Fetch the conversation transcript using the helper function
          const conversation = await fetchIntercomConversation(conversationId);
          const { html: conversationHtml, attachments } = await formatConversationAsHtml(conversation);

          // Add Intercom conversation URL above the chat transcript
          // Use the same pattern as other parts of the code
          const intercomUrl = `${process.env.INTERCOM_INBOX_URL}/conversation/${conversationId}`;
          console.log('INTERCOM_INBOX_URL from env:', process.env.INTERCOM_INBOX_URL);
          console.log('Constructed Intercom URL:', intercomUrl);
          
          // Create the note body with proper newlines and URL section above the transcript
          // Use HTML formatting to ensure proper line breaks in Freshdesk
          const noteBody = `<div>Chat Transcript Added</div><br><div>Intercom Conversation URL: <a href="${intercomUrl}" target="_blank">${intercomUrl}</a></div><br>${conversationHtml}`;

          if (attachments && attachments.length > 0) {
            // Case 1: Note with attachments (multipart/form-data)
            const formData = new FormData();
            formData.append('body', noteBody);
            formData.append('private', 'true');

            for (const attachment of attachments) {
              try {
                const fileBuffer = await downloadFile(attachment.url, attachment.name);
                if (fileBuffer) {
                  formData.append('attachments[]', fileBuffer, { filename: attachment.name, contentType: attachment.content_type || 'application/octet-stream' });
                }
              } catch (err) {
                console.error(`Failed to process attachment ${attachment.name}:`, err.message);
              }
            }

            await axios.post(`${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}/notes`, formData, {
              headers: { ...formData.getHeaders() },
              auth: { username: FRESHDESK_API_KEY, password: FRESHDESK_PASSWORD },
            });
          } else {
            // Case 2: Note without attachments (application/json)
            await axios.post(`${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}/notes`, 
              { body: noteBody, private: true },
              { auth: { username: FRESHDESK_API_KEY, password: FRESHDESK_PASSWORD } }
            );
          }

          // Post success note to Intercom
          await postIntercomNote(conversationId, `Successfully added conversation as a note to Freshdesk ticket #${ticketId}.`);
        } catch (error) {
          console.error('Error adding note to Freshdesk ticket:', error.response ? error.response.data : error.message);
          const errorMessage = `Failed to add note to Freshdesk ticket. Details: ${error.response ? JSON.stringify(error.response.data.errors) : error.message}`;
          // Post failure note to Intercom
          await postIntercomNote(conversationId, errorMessage);
        }
      })();
    } else if (req.body.component_id === 'cancel_merge') {
      // Return to the home screen, fetching recent tickets to display.
      const customerEmail = app.locals.intercomContext?.customerEmail || req.body.contact?.email || req.body.customer?.email;
      const components = [
        { type: 'button', id: 'create_ticket', label: 'Create a Freshdesk Ticket', style: 'primary', action: { type: 'submit' } },
        { type: 'spacer', size: 's' },
        { type: 'button', id: 'add_to_existing_ticket', label: 'Add to existing Freshdesk Ticket', action: { type: 'submit' } }
      ];

      if (customerEmail) {
        // Use home page state if available, otherwise fetch fresh tickets
        if (app.locals.homePageState && app.locals.homePageState.customerEmail === customerEmail) {
          const displayedTickets = app.locals.homePageState.allTickets.slice(0, app.locals.homePageState.currentOffset);
          const recentTicketsComponent = buildRecentTicketsComponent(displayedTickets, app.locals.homePageState.hasMore);
          components.push(...recentTicketsComponent);
        } else {
          const recentTickets = await fetchRecentTickets(customerEmail);
          const recentTicketsComponent = buildRecentTicketsComponent(recentTickets);
          components.push(...recentTicketsComponent);
        }
      }

      sendResponse({
        canvas: {
          content: { components: components }
        }
      });
    } else if (req.body.component_id === 'back_to_home') {
      // Handle back to home button from merge page
      console.log('Back to home button clicked from merge page');
      const customerEmail = app.locals.intercomContext?.customerEmail || req.body.contact?.email || req.body.customer?.email;
      const components = [
        { type: 'button', id: 'create_ticket', label: 'Create a Freshdesk Ticket', style: 'primary', action: { type: 'submit' } },
        { type: 'spacer', size: 's' },
        { type: 'button', id: 'add_to_existing_ticket', label: 'Add to existing Freshdesk Ticket', action: { type: 'submit' } }
      ];

      if (customerEmail) {
        // Use home page state if available, otherwise fetch fresh tickets
        if (app.locals.homePageState && app.locals.homePageState.customerEmail === customerEmail) {
          const displayedTickets = app.locals.homePageState.allTickets.slice(0, app.locals.homePageState.currentOffset);
          const recentTicketsComponent = buildRecentTicketsComponent(displayedTickets, app.locals.homePageState.hasMore);
          components.push(...recentTicketsComponent);
        } else {
          const recentTickets = await fetchRecentTickets(customerEmail);
          const recentTicketsComponent = buildRecentTicketsComponent(recentTickets);
          components.push(...recentTicketsComponent);
        }
      }

      sendResponse({
        canvas: {
          content: { components: components }
        }
      });
    } else if (req.body.component_id === 'load_more_tickets') {
      // Handle load more tickets button
      console.log('Load more tickets button clicked');
      
      const mergeState = app.locals.mergePageState;
      if (!mergeState) {
        console.error('No merge page state found');
        return sendResponse({
          canvas: {
            content: {
              components: [
                { type: 'text', text: 'Error: Session expired. Please try again.', align: 'center' },
                { type: 'button', id: 'back_to_home', label: 'Back to Home', action: { type: 'submit' } }
              ]
            }
          }
        });
      }

      try {
        console.log(`Loading more tickets - Current offset: ${mergeState.currentOffset}, Total tickets available: ${mergeState.allTickets.length}`);
        
        // Get the next 5 tickets from the already fetched list
        const startIndex = mergeState.currentOffset;
        const endIndex = Math.min(startIndex + 5, mergeState.allTickets.length);
        const newTickets = mergeState.allTickets.slice(startIndex, endIndex);
        
        console.log(`Showing tickets ${startIndex} to ${endIndex}: ${newTickets.length} tickets`);
        console.log('New tickets to show:', newTickets.map(t => `#${t.id} - ${t.subject}`));
        
        // Update the offset
        mergeState.currentOffset = endIndex;
        mergeState.hasMore = endIndex < mergeState.allTickets.length;
        
        console.log(`Updated state - Current offset: ${mergeState.currentOffset}, Has more: ${mergeState.hasMore}`);

        const components = [];

        components.push({
          type: 'text',
          text: 'Select a ticket to merge this conversation into:',
          style: 'header'
        });

        // Display all tickets that have been loaded so far
        const displayedTickets = mergeState.allTickets.slice(0, mergeState.currentOffset);
        displayedTickets.forEach(ticket => {
          components.push({
            type: 'button',
            id: `select_ticket_${ticket.id}`,
            label: `#${ticket.id} - ${ticket.subject}`,
            style: 'secondary',
            action: {
              type: 'submit'
            }
          });
          components.push({ type: 'spacer', size: 's' });
        });
        
        // Add Load More button if there might be more tickets
        if (mergeState.hasMore) {
          components.push({ type: 'spacer', size: 'm' });
          components.push({
            type: 'button',
            id: 'load_more_tickets',
            label: 'Load More Tickets',
            style: 'secondary',
            action: {
              type: 'submit'
            }
          });
        }
        
        // Add back button
        components.push({ type: 'spacer', size: 'm' });
        components.push({
          type: 'button',
          id: 'back_to_home',
          label: 'Back to Home',
          style: 'secondary',
          action: {
            type: 'submit'
          }
        });

        sendResponse({
          canvas: {
            content: {
              components: components
            }
          }
        });

      } catch (error) {
        console.error('Error fetching more tickets:', error);
        sendResponse({
          canvas: {
            content: {
              components: [
                { type: 'text', text: 'Error fetching more tickets. Please try again.', align: 'center' },
                { type: 'button', id: 'back_to_home', label: 'Back to Home', action: { type: 'submit' } }
              ]
            }
          }
        });
      }
    } else if (req.body.component_id === 'load_more_home_tickets') {
      // Handle load more tickets button on home page
      console.log('Load more home tickets button clicked');
      
      const homeState = app.locals.homePageState;
      if (!homeState) {
        console.error('No home page state found');
        return sendResponse({
          canvas: {
            content: {
              components: [
                { type: 'text', text: 'Error: Session expired. Please try again.', align: 'center' },
                { type: 'button', id: 'create_ticket', label: 'Create a Freshdesk Ticket', style: 'primary', action: { type: 'submit' } }
              ]
            }
          }
        });
      }

      try {
        console.log(`Loading more home tickets - Current offset: ${homeState.currentOffset}, Total tickets available: ${homeState.allTickets.length}`);
        
        // Get the next 5 tickets from the already fetched list
        const startIndex = homeState.currentOffset;
        const endIndex = Math.min(startIndex + 5, homeState.allTickets.length);
        const newTickets = homeState.allTickets.slice(startIndex, endIndex);
        
        console.log(`Showing home tickets ${startIndex} to ${endIndex}: ${newTickets.length} tickets`);
        
        // Update the offset
        homeState.currentOffset = endIndex;
        homeState.hasMore = endIndex < homeState.allTickets.length;
        
        console.log(`Updated home state - Current offset: ${homeState.currentOffset}, Has more: ${homeState.hasMore}`);

        // Create components for home page
        const components = [
          {
            type: 'spacer',
            size: 'm'
          },
          {
            type: 'button',
            id: 'create_ticket',
            label: 'Create a Freshdesk Ticket',
            style: 'primary',
            action: {
              type: 'submit'
            }
          },
          {
            type: 'spacer',
            size: 's'
          },
          {
            type: 'button',
            id: 'add_to_existing_ticket',
            label: 'Add to existing Freshdesk Ticket',
            style: 'secondary',
            action: {
              type: 'submit'
            }
          },
          {
            type: 'spacer',
            size: 'l'
          }
        ];

        // Display all tickets that have been loaded so far
        const displayedTickets = homeState.allTickets.slice(0, homeState.currentOffset);
        const recentTicketsComponent = buildRecentTicketsComponent(displayedTickets, homeState.hasMore);
        components.push(...recentTicketsComponent);

        sendResponse({
          canvas: {
            content: {
              components: components
            }
          }
        });

      } catch (error) {
        console.error('Error loading more home tickets:', error);
        sendResponse({
          canvas: {
            content: {
              components: [
                { type: 'text', text: 'Error loading more tickets. Please try again.', align: 'center' },
                { type: 'button', id: 'create_ticket', label: 'Create a Freshdesk Ticket', style: 'primary', action: { type: 'submit' } }
              ]
            }
          }
        });
      }
    } else if (req.body.component_id === 'submit_ticket_button') {
      // Extract values from the form submission
      // in Intercom's format, form values are stored at req.body.input_values
      const inputValues = req.body.input_values || {};
      console.log('Form input values:', inputValues);
      
      // -------------------------------------------------------------
      // VALIDATE REQUIRED FIELDS - Email and Subject
      // -------------------------------------------------------------
      
      // Check if any required fields are empty
      const isEmailEmpty = !inputValues.email || inputValues.email.trim() === '';
      const isSubjectEmpty = !inputValues.subject || inputValues.subject.trim() === '';
      
      // If either required field is empty, show validation errors
      if (isEmailEmpty || isSubjectEmpty) {
        console.log(`VALIDATION ERROR: Required fields missing - Email: ${isEmailEmpty}, Subject: ${isSubjectEmpty}`);
        
        // Recreate the form showing the error
        // Get required data for dropdowns
        let activeMailboxes = [];
        let statusChoices = [];
        let priorityChoices = [];
        
        try {
          // Get mailboxes for the form
          const mailboxesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/email/mailboxes`, { method: 'GET' });
          activeMailboxes = mailboxesResponse.data.filter(mailbox => mailbox.active === true);
          
          // Get ticket field data
          const fieldsResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields`, { method: 'GET' });
          
          // Get status field
          const statusField = fieldsResponse.data.find(field => field.name === 'status');
          if (statusField) {
            const statusChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${statusField.id}`, { method: 'GET' });
            statusChoices = statusChoicesResponse.data.choices;
          }
          
          // Get priority field
          const priorityField = fieldsResponse.data.find(field => field.name === 'priority');
          if (priorityField) {
            const priorityChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${priorityField.id}`, { method: 'GET' });
            priorityChoices = priorityChoicesResponse.data.choices;
          }
        } catch (error) {
          console.error('Error fetching form data:', error.message);
        }
        
        // Build the error form
        const errorForm = [
          {
            type: 'text',
            text: isEmailEmpty && isSubjectEmpty ? 'Email and Subject are required' : 
                  isEmailEmpty ? 'Email is required' : 'Subject is required',
            style: 'error'
          },
          {
            type: 'input',
            id: 'email',
            label: 'Email',
            value: isEmailEmpty ? '' : inputValues.email,
            placeholder: 'Enter email address',
            error: isEmailEmpty ? 'Email is required' : undefined,
            validation_rules: {
              required: { error: 'Email is required' },
              format: { type: 'email_address', error: 'Please enter a valid email address' }
            }
          },
          {
            type: 'input',
            id: 'subject',
            label: 'Subject',
            value: isSubjectEmpty ? '' : (inputValues.subject || defaultTitle || 'New Ticket'),
            error: isSubjectEmpty ? 'Subject is required' : undefined,
            validation_rules: {
              required: { error: 'Subject is required' }
            }
          },
          {
            type: 'textarea',
            id: 'description',
            label: 'Description',
            value: inputValues.description || 'Chat Transcript Added'
          }
        ];
        
        // Add product dropdown

        
        // Add status dropdown
        if (statusChoices.length > 0) {
          errorForm.push({
            type: 'dropdown',
            id: 'status',
            label: 'Status',
            value: inputValues.status || 'status_2',
            options: statusChoices.map(status => ({
              type: 'option',
              id: `status_${status.id}`,
              text: status.label,
              value: status.id.toString()
            }))
          });
        }
        
        // Add priority dropdown
        if (priorityChoices.length > 0) {
          errorForm.push({
            type: 'dropdown',
            id: 'priority',
            label: 'Priority',
            value: inputValues.priority || 'priority_2',
            options: priorityChoices.map(priority => ({
              type: 'option',
              id: `priority_${priority.value}`,
              text: priority.label,
              value: priority.value.toString()
            }))
          });
        }
        
        // Add action buttons
        errorForm.push(
          {
            type: 'button',
            id: 'submit_ticket_button',
            label: 'Create Ticket',
            style: 'primary',
            action: {
              type: 'submit'
            }
          },
          {
            type: 'button',
            id: 'cancel',
            label: 'Cancel',
            style: 'secondary',
            action: {
              type: 'submit'
            }
          }
        );
        
        // Return the error form with explicit validation errors
        sendResponse({
          canvas: {
            content: {
              components: errorForm,
              validation_errors: {
                email: isEmailEmpty ? 'Email is required' : undefined,
                subject: isSubjectEmpty ? 'Subject is required' : undefined
              }
            }
          }
        });
        return;
      }
      
      // If we got past the validation, proceed with normal flow
      const userProvidedEmail = inputValues.email.trim();
      const userProvidedSubject = inputValues.subject.trim();
      const email = userProvidedEmail;
      const subject = userProvidedSubject;
      let description = inputValues.description || defaultDescription || '';
      

      
      // Extract status directly from the status number
      let status = '';
      if (inputValues.status) {
        // Direct approach - extract just the numbers at the end
        status = inputValues.status.replace('status_', '');
        console.log('Extracted status:', status);
      }
      
      // Extract priority directly from the priority number
      let priority = '';
      if (inputValues.priority) {
        // Direct approach - extract just the numbers at the end
        priority = inputValues.priority.replace('priority_', '');
        console.log('Extracted priority:', priority);
      }
      
      console.log('Extracted values for ticket creation:', {
        email,
        subject,
        description,
        status,
        priority
      });
      
      // Additional validation check (this should never be reached due to the earlier check)
      if (!email || !subject) {
        console.error(`Required fields missing: Email: ${!email}, Subject: ${!subject}`);
        
        // Recreate the form with the error message, preserving the entered values
        // First create the basic form components
        const errorFormComponents = [
          {
            type: 'text',
            text: 'Create a new Freshdesk ticket',
            style: 'header'
          },
          {
            type: 'input',
            id: 'email',
            label: 'Email',
            value: '',  // Keep empty to show the validation error
            placeholder: 'Enter email address',
            validation_rules: {
              required: { error: 'Email is required' },
              format: { type: 'email_address', error: 'Please enter a valid email address' }
            },
            error: 'Email is required'  // Highlight in red
          },
          {
            type: 'input',
            id: 'subject',
            label: 'Subject',
            value: subject || defaultTitle || 'New Ticket'
          },
          {
            type: 'textarea',
            id: 'description',
            label: 'Description',
            value: description || defaultDescription || ''
          }
        ];
        

        
        // Add the same status dropdown
        if (inputValues.status) {
          errorFormComponents.push({
            type: 'dropdown',
            id: 'status',
            label: 'Status',
            value: inputValues.status
          });
        }
        
        // Add the same priority dropdown
        if (inputValues.priority) {
          errorFormComponents.push({
            type: 'dropdown',
            id: 'priority',
            label: 'Priority',
            value: inputValues.priority
          });
        }
        
        // Add the action buttons
        errorFormComponents.push(
          {
            type: 'button',
            id: 'submit_ticket_button',
            label: 'Create Ticket',
            style: 'primary',
            disabled: false,
            action: {
              type: 'submit'
            }
          },
          {
            type: 'button',
            id: 'cancel',
            label: 'Cancel',
            style: 'secondary',
            disabled: false,
            action: {
              type: 'submit'
            }
          }
        );
        
        sendResponse({
          canvas: {
            content: {
              components: errorFormComponents,
              validation_errors: {
                email: 'Email is required'
              }
            }
          }
        });
        return;
      }
      
      // Validate other required fields
      if (!subject || !description) {
        console.error('Missing required fields in form submission');
        sendResponse({
          canvas: {
            content: {
              components: [
                {
                  type: 'text',
                  text: 'Please fill in all required fields',
                  style: 'error'
                },
                {
                  type: 'button',
                  id: 'try_again',
                  label: 'Try Again',
                  style: 'primary',
                  action: {
                    type: 'reload'
                  }
                }
              ]
            }
          }
        });
        return;
      }
      
      // Store conversation ID for later use, even if we timeout
      const conversationId = req.body.conversation_id || req.body.conversation?.id;
      if (conversationId) {
        console.log(`Found conversation ID: ${conversationId}, will be used for notification`);
      }
      
      // Fetch current recent tickets to display while ticket creation continues in background
      let recentTickets = [];
      try {
        // Get the user's email from the ticket data
        const userEmail = email;
        console.log(`Fetching recent tickets for email: ${userEmail}`);
        
        // Fetch recent tickets from Freshdesk API
        const recentTicketsResponse = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(userEmail)}&order_by=created_at&order_type=desc&per_page=5`, {
          auth: {
            username: FRESHDESK_API_KEY,
            password: FRESHDESK_PASSWORD
          },
          headers: {
            'Content-Type': 'application/json'
          }
        });
        
        if (recentTicketsResponse.data && recentTicketsResponse.data.length > 0) {
          recentTickets = recentTicketsResponse.data;
        }
      } catch (error) {
        console.error('Error fetching recent tickets:', error.response?.data || error.message);
      }
      
      // Create components for immediate response using home page state
      const customerEmail = req.body.contact?.email || req.body.customer?.email || app.locals.intercomContext?.customerEmail;
      const components = [
        {
          type: 'spacer',
          size: 'm'
        },
        {
          type: 'button',
          id: 'create_ticket',
          label: 'Create a Freshdesk Ticket',
          style: 'primary',
          action: {
            type: 'submit'
          }
        },
        { type: 'spacer', size: 's' },
        {
          type: 'button',
          id: 'add_to_existing_ticket',
          label: 'Add to existing Freshdesk Ticket',
          action: { type: 'submit' }
        },
        {
          type: 'spacer',
          size: 'l'
        }
      ];

      // Use home page state if available, otherwise fetch fresh tickets
      if (customerEmail) {
        if (app.locals.homePageState && app.locals.homePageState.customerEmail === customerEmail) {
          const displayedTickets = app.locals.homePageState.allTickets.slice(0, app.locals.homePageState.currentOffset);
          const recentTicketsComponent = buildRecentTicketsComponent(displayedTickets, app.locals.homePageState.hasMore);
          components.push(...recentTicketsComponent);
        } else {
          // If no home page state, create one
          try {
            const ticketsResponse = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(customerEmail)}&order_by=created_at&order_type=desc&per_page=20&page=1`, {
              auth: {
                username: FRESHDESK_API_KEY,
                password: FRESHDESK_PASSWORD
              }
            });

            const allTickets = ticketsResponse.data;
            
            // Initialize home page state
            app.locals.homePageState = {
              customerEmail: customerEmail,
              currentOffset: 5,
              allTickets: allTickets,
              hasMore: allTickets.length > 5
            };
            
            const recentTickets = allTickets.slice(0, 5);
            const recentTicketsComponent = buildRecentTicketsComponent(recentTickets, app.locals.homePageState.hasMore);
            components.push(...recentTicketsComponent);
          } catch (error) {
            console.error('Error fetching tickets for home page:', error);
            const recentTicketsComponent = buildRecentTicketsComponent([]);
            components.push(...recentTicketsComponent);
          }
        }
      }
      
      // No status message needed - removed as requested
      
      // Mark that ticket creation is in progress for this email
      if (email) {
        ticketTracker.set(email, {
          inProgress: true,
          startedAt: new Date().toISOString()
        });
        console.log(`Marked ticket creation as in-progress for ${email}`);
      }
      
      // Send immediate response with homepage view
      sendResponse({
        canvas: {
          content: {
            components: components
          }
        }
      });
      
      // Process the ticket creation in the background
      setTimeout(async () => {
        try {
          let transcriptHtml = '';
          
          if (conversationId) {
            console.log(`Processing in background: Found conversation ID: ${conversationId}, fetching transcript...`);
            try {
              // Fetch conversation details from Intercom
              const conversation = await fetchIntercomConversation(conversationId);
              
              // Format the conversation as HTML
              const { html } = await formatConversationAsHtml(conversation);
              transcriptHtml = html;
              console.log('Successfully generated conversation transcript');
              
              // Add the transcript to the description
              if (transcriptHtml) {
                description += '\n\n' + transcriptHtml;
              }
            } catch (error) {
              console.error('Error fetching or formatting conversation:', error);
              // Continue with ticket creation even if transcript fails
            }
          }
          
          // Prepare ticket data
          const ticketData = {
            email,
            subject,
            description,
            source: 2 // Web form
          };
          
          // Add optional fields if provided
          if (status) ticketData.status = parseInt(status, 10);
          if (priority) ticketData.priority = parseInt(priority, 10);
          
          // Add conversation transcript to ticket data if conversation ID is available
          let ticketDataWithTranscript = ticketData;
          if (conversationId) {
            console.log('Adding conversation transcript to ticket...');
            ticketDataWithTranscript = await addConversationTranscriptToTicket(ticketData, conversationId);
          }
          
          // Create ticket in Freshdesk
          const ticketResponse = await createFreshdeskTicket(ticketDataWithTranscript);
          console.log('Background processing: Ticket created successfully:', ticketResponse);
          
          // Get ticket URL for the console (for reference)
          const ticketUrl = `${FRESHDESK_DOMAIN}/a/tickets/${ticketResponse.id}`;
          console.log(`\u2705 Background processing: Ticket created successfully: ${ticketUrl}`);
          
          // Post a note to the Intercom conversation with the Freshdesk ticket URL
          if (conversationId) {
            const noteBody = `Freshdesk Ticket creation successful.\nTicket URL: ${ticketUrl}`;
            await postIntercomNote(conversationId, noteBody);
          }
          
          // Store the completed ticket information for future Canvas loads
          if (email) {
            ticketTracker.set(email, {
              inProgress: false,
              ticketId: ticketResponse.id,
              createdAt: new Date().toISOString()
            });
            console.log(`Background processing: Tracked completed ticket for ${email}: ${ticketResponse.id}`);
          }
        } catch (error) {
          console.error('Background processing: Error creating ticket:', error.response?.data || error.message);
          
          // Post a note to the Intercom conversation about the failure
          if (conversationId) {
            const errorMessage = error.response?.data?.message || error.message;
            const noteBody = `Freshdesk Ticket creation failed. Contact Admin.\nError: ${errorMessage}`;
            await postIntercomNote(conversationId, noteBody);
          }
          
          // Update the ticket tracker to show the creation failed
          if (email) {
            ticketTracker.set(email, {
              inProgress: false,
              error: error.response?.data?.message || error.message,
              createdAt: new Date().toISOString()
            });
          }
        }
      }, 0);
      
      // Return from the route handler since we've already sent the response
      return;
    } else if (req.body.component_id === 'cancel') {
      // Handle cancel button - don't show 'Ticket creation cancelled' message
      // Instead, fetch recent tickets and display them
      try {
        // Get customer email from the request body or app.locals
        const customerEmail = req.body.contact?.email || req.body.customer?.email || app.locals.intercomContext?.customerEmail;
        
        // Create components array for the response using home page state
        const components = [
          {
            type: 'spacer',
            size: 'm'
          },
          {
            type: 'button',
            id: 'create_ticket',
            label: 'Create a Freshdesk Ticket',
            style: 'primary',
            action: {
              type: 'submit'
            }
          },
          {
            type: 'spacer',
            size: 's'
          },
          {
            type: 'button',
            id: 'add_to_existing_ticket',
            label: 'Add to existing Freshdesk Ticket',
            style: 'secondary',
            action: {
              type: 'submit'
            }
          },
          {
            type: 'spacer',
            size: 'l'
          }
        ];
        
        // Use home page state if available, otherwise fetch fresh tickets
        if (customerEmail) {
          if (app.locals.homePageState && app.locals.homePageState.customerEmail === customerEmail) {
            const displayedTickets = app.locals.homePageState.allTickets.slice(0, app.locals.homePageState.currentOffset);
            const recentTicketsComponent = buildRecentTicketsComponent(displayedTickets, app.locals.homePageState.hasMore);
            components.push(...recentTicketsComponent);
          } else {
            // If no home page state, create one
            try {
              const ticketsResponse = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(customerEmail)}&order_by=created_at&order_type=desc&per_page=20&page=1`, {
                auth: {
                  username: FRESHDESK_API_KEY,
                  password: FRESHDESK_PASSWORD
                }
              });

              const allTickets = ticketsResponse.data;
              
              // Initialize home page state
              app.locals.homePageState = {
                customerEmail: customerEmail,
                currentOffset: 5,
                allTickets: allTickets,
                hasMore: allTickets.length > 5
              };
              
              const recentTickets = allTickets.slice(0, 5);
              const recentTicketsComponent = buildRecentTicketsComponent(recentTickets, app.locals.homePageState.hasMore);
              components.push(...recentTicketsComponent);
            } catch (error) {
              console.error('Error fetching tickets for home page:', error);
              const recentTicketsComponent = buildRecentTicketsComponent([]);
              components.push(...recentTicketsComponent);
            }
          }
        }
        
        // Return the response with the components
        sendResponse({
          canvas: {
            content: {
              components: components
            }
          }
        });
        return;
      } catch (error) {
        console.error('Error handling cancel button:', error);
        // Return a simple response if there's an error
        sendResponse({
          canvas: {
            content: {
              components: [
                {
                  type: 'button',
                  id: 'create_ticket',
                  label: 'Create a Ticket',
                  style: 'primary',
                  action: {
                    type: 'submit'
                  }
                },
                {
                  type: 'divider'
                },
                {
                  type: 'text',
                  id: 'recent_tickets_header',
                  text: 'Recent Tickets',
                  style: 'header'
                },
                {
                  type: 'text',
                  id: 'no_tickets',
                  text: 'No recent tickets',
                  style: 'muted'
                }
              ]
            }
          }
        });
        return;
      }
    } else if (req.body.component_id === 'refresh_status' || req.body.component_id === 'retry_button') {
      // Handle retry button click - redirect back to create_ticket
      return res.json({
        canvas: {
          content: {
            components: [
              {
                type: 'button',
                id: 'create_ticket',
                label: 'Create a Freshdesk Ticket',
                style: 'primary',
                action: {
                  type: 'submit'
                }
              },
              {
                type: 'divider'
              },
              {
                type: 'text',
                id: 'recent_tickets_header',
                text: 'Recent Tickets',
                style: 'header'
              },
              {
                type: 'text',
                id: 'no_tickets',
                text: 'No recent tickets',
                style: 'muted'
              }
            ]
          }
        }
      });
    } else {
      // Default fallback response for any other button clicks
      return res.json({
        canvas: {
          content: {
            components: [
              {
                type: 'button',
                id: 'create_ticket',
                label: 'Create a Freshdesk Ticket',
                style: 'primary',
                action: {
                  type: 'submit'
                }
              },
              {
                type: 'divider'
              },
              {
                type: 'text',
                id: 'recent_tickets_header',
                text: 'Recent Tickets',
                style: 'header'
              },
              {
                type: 'text',
                id: 'no_tickets',
                text: 'No recent tickets',
                style: 'muted'
              }
            ]
          }
        }
      });
    }
  } catch (error) {
    console.error('Error processing form submission:', error);
    
    sendResponse({
      canvas: {
        content: {
          components: [
            {
              type: 'text',
              text: `An error occurred: ${error.message}`,
              style: 'error'
            },
            {
              type: 'button',
              id: 'try_again',
              label: 'Try Again',
              style: 'primary',
              action: {
                type: 'reload'
              }
            },
            {
              type: 'divider'
            },
            {
              type: 'text',
              id: 'recent_tickets_header',
              text: 'Recent Tickets',
              style: 'header'
            },
            {
              type: 'text',
              id: 'no_tickets',
              text: 'No recent tickets',
              style: 'muted'
            }
          ]
        }
      }
    });
    return;
  }
});

// We already have an initialize endpoint defined above, so this one is removed

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
