const axios = require('axios');
const he = require('he'); // For HTML entity encoding/decoding

// Helper function to fetch Intercom conversation details
async function fetchIntercomConversation(conversationId) {
  try {
    console.log(`Fetching Intercom conversation: ${conversationId}`);
    const response = await axios.get(
      `${process.env.INTERCOM_API_URL}/conversations/${conversationId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.INTERCOM_ACCESS_TOKEN}`,
          'Accept': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error fetching Intercom conversation:', error.response ? error.response.data : error.message);
    return null; // Return null instead of throwing to gracefully handle errors
  }
}

// Helper function to download file from a URL
async function downloadFile(url, filename) {
  try {
    // Ensure URL doesn't have HTML entities
    const cleanUrl = url.replace(/&amp;/g, '&');
    
    console.log(`Downloading file: ${filename} from ${cleanUrl}`);
    
    try {
      const response = await axios({
        url: cleanUrl,
        method: 'GET',
        responseType: 'arraybuffer',
        // Set a longer timeout for image downloads
        timeout: 30000,
        // Add headers to mimic a browser request
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://app.intercom.com/'
        }
      });
      
      console.log(`Successfully downloaded ${filename}, size: ${response.data.length} bytes`);
      return response.data;
    } catch (fetchError) {
      console.error(`Error with primary download method for ${filename}:`, fetchError.message);
      
      // If the first attempt fails, try a fallback approach
      console.log(`Trying fallback method for downloading ${filename}...`);
      
      // Try without some of the query parameters that might be causing issues
      const simplifiedUrl = cleanUrl.split('?')[0];
      console.log(`Trying simplified URL: ${simplifiedUrl}`);
      
      const fallbackResponse = await axios({
        url: simplifiedUrl,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000
      });
      
      console.log(`Fallback download successful for ${filename}`);
      return fallbackResponse.data;
    }
  } catch (error) {
    console.error(`All download attempts failed for ${filename}:`, error.message);
    return null;
  }
}

// Helper function to extract inline images from HTML content and assign sequential names
function extractInlineImages(htmlContent, startIndex) {
  const extractedImages = []; // Stores { url: string, filename: string (sequential) }
  let currentIndex = startIndex;
  let modifiedHtml = htmlContent;

  if (!htmlContent || typeof htmlContent !== 'string') {
    // console.warn('extractInlineImages: htmlContent is null or not a string.');
    return {
      modifiedHtml: htmlContent || '', // Return original or empty if null
      extractedImages: [],
      nextIndex: startIndex,
    };
  }

  // Regex to find <img> tags and capture their src
  const imgTagRegex = /<img\s+[^>]*src="([^"]+)"[^>]*>/gi;
  
  const matches = [];
  let match;
  while ((match = imgTagRegex.exec(htmlContent)) !== null) {
    matches.push({
      fullTag: match[0], // The entire <img> tag
      url: match[1]      // The URL from src="..."
    });
  }

  for (const imgMatch of matches) {
    let originalUrl = imgMatch.url;
    originalUrl = he.decode(originalUrl); // Decode HTML entities like &amp;

    let originalFilename = 'image.png'; // Default filename
    let extension = 'png'; // Default extension

    try {
      const parsedUrl = new URL(originalUrl);
      const pathname = parsedUrl.pathname;
      const filenameFromPath = pathname.substring(pathname.lastIndexOf('/') + 1);
      
      if (filenameFromPath) {
        originalFilename = decodeURIComponent(filenameFromPath);
        const dotIndex = originalFilename.lastIndexOf('.');
        if (dotIndex !== -1 && dotIndex < originalFilename.length - 1) {
          extension = originalFilename.substring(dotIndex + 1).toLowerCase();
        }
      }
    } catch (e) {
      // console.warn(`Could not parse URL to get original filename: ${originalUrl}. Error: ${e.message}`);
      const filenameMatch = originalUrl.match(/[^/\\&?#]+\.(jpg|jpeg|gif|png|bmp|webp|svg)(?=[?#]|$)/i);
      if (filenameMatch && filenameMatch[0]) {
        originalFilename = filenameMatch[0];
        const dotIndex = originalFilename.lastIndexOf('.');
        if (dotIndex !== -1 && dotIndex < originalFilename.length - 1) {
          extension = originalFilename.substring(dotIndex + 1).toLowerCase();
        }
      } else {
        // console.warn(`Fallback filename extraction also failed for URL: ${originalUrl}. Using default 'image.png'.`);
      }
    }

    const sequentialFilename = `image ${currentIndex}.${extension}`;
    const placeholderText = `[Inline image: ${sequentialFilename}]`;

    modifiedHtml = modifiedHtml.replace(imgMatch.fullTag, placeholderText);
    
    extractedImages.push({
      url: originalUrl,
      filename: sequentialFilename,
    });
    currentIndex++;
  }

  return {
    modifiedHtml: modifiedHtml,
    extractedImages: extractedImages,
    nextIndex: currentIndex,
  };
}

// Helper function to format conversation parts as HTML chat transcript
async function formatConversationAsHtml(conversation, intercomWorkspaceId) {
  // Helper function to escape special characters for regex
  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\\\]\\]/g, '\\$&'); // $& means the whole matched string
  }

  if (!conversation) {
    console.error('formatConversationAsHtml: Conversation object is null or undefined.');
    throw new Error('Invalid conversation data provided for transcript generation.');
  }

  let html = '<html><body>'; // Start with HTML structure
  const allAttachments = [];
  let globalInlineImageCounter = 1;
  const dateOptions = {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  };

  // The overall header (Chat Transcript Added, Intercom URL) is now handled by createFreshdeskTicket

  // Process the source (initial message) of the conversation
  if (conversation.source) {
    const sourcePart = conversation.source;
    let messageBody = sourcePart.body || '';
    const hasAttachmentsInSource = sourcePart.attachments && sourcePart.attachments.length > 0;

    // Only process if there's a body or attachments
    if (!(messageBody.trim() === '' && !hasAttachmentsInSource)) {
      const isAdmin = sourcePart.author && (sourcePart.author.type === 'admin' || sourcePart.author.type === 'bot');
      let authorName = 'User';
      if (sourcePart.author) {
        if (isAdmin && sourcePart.author.name) {
          authorName = sourcePart.author.name;
        } else if (!isAdmin && sourcePart.author.name) {
          authorName = sourcePart.author.name;
        } else if (sourcePart.author.email) {
          authorName = sourcePart.author.email.split('@')[0];
        } else if (sourcePart.author.type) { // Fallback to type if name/email missing
          authorName = sourcePart.author.type.charAt(0).toUpperCase() + sourcePart.author.type.slice(1);
        }
      }

      // const isNote = false; // Source is not a 'note'
      const authorColor = isAdmin ? '#30446c' : '#100c0c'; // Author name color (remains for text above bubble)
      const messageBgColor = isAdmin ? '#30446c' : '#100c0c';    // Bubble background: Admin dark blue, User dark gray/black
      const messageTextColor = '#FFFFFF';                         // Message text color: White for dark backgrounds
      const timestampColor = isAdmin ? '#30446c' : '#100c0c';     // Timestamp color: Same as bubble color for better visibility
      const alignment = isAdmin ? 'right' : 'left';

      const createdAtTimestamp = sourcePart.created_at || conversation.created_at;
      const date = new Date(createdAtTimestamp * 1000);
      const timeString = date.toLocaleString('en-IN', dateOptions).replace(',', '');

      if (messageBody.startsWith('<p>') && messageBody.endsWith('</p>')) {
        messageBody = messageBody.substring(3, messageBody.length - 4);
      }

      const imageExtractionResult = extractInlineImages(messageBody, globalInlineImageCounter);
      messageBody = imageExtractionResult.modifiedHtml;
      globalInlineImageCounter = imageExtractionResult.nextIndex;
      imageExtractionResult.extractedImages.forEach(img => {
        allAttachments.push({
          url: img.url, name: img.filename,
          content_type: 'image/' + img.filename.split('.').pop(), type: 'inline_image'
        });
      });

      html += `<div style="margin-bottom: 16px; text-align: ${alignment};">`;
      html += `  <div style="color: ${authorColor}; font-weight: bold; margin-bottom: 2px;">${he.encode(authorName)}</div>`;
      html += `  <div style="background-color: ${messageBgColor}; color: ${messageTextColor}; padding: 10px 12px; border-radius: 8px; display: inline-block; max-width: 80%; margin-top: 4px; text-align: left; word-wrap: break-word;">`;
      html += messageBody ? messageBody.replace(/\r\n|\r|\n/g, '<br>') : (hasAttachmentsInSource ? '' : '(No message body)');
      html += `  </div>`;
      
      if (hasAttachmentsInSource) {
        for (const att of sourcePart.attachments) {
          allAttachments.push({
            url: att.url, name: att.name,
            content_type: att.content_type, type: 'regular_attachment'
          });
          // Check if attachment reference already exists in the message body (using the messageBody before our own modifications)
          const encodedAttName = he.encode(att.name);
          const patternString = `\\[\\s*Attachment:\\s*${escapeRegExp(encodedAttName)}\\s*\\]`;
          const attachmentReferencePattern = new RegExp(patternString, 'i');
          if (!messageBody || !messageBody.match(attachmentReferencePattern)) {
            html += `<div style="font-style: italic; font-size: 12px; color: ${timestampColor}; margin-top: 4px; max-width: 80%; display: inline-block;"><em>[Attachment: ${encodedAttName}]</em></div>`;
          }
        }
      }
      html += `  <div style="font-size: 12px; color: ${timestampColor}; margin-top: 4px;">${timeString}</div>`;
      html += `</div>`;
    }
  }

  // Process conversation parts (subsequent messages)
  const conversationParts = (conversation.conversation_parts && conversation.conversation_parts.conversation_parts) || [];
  // Ensure parts are sorted if not already (Intercom usually sorts them)
  // conversationParts.sort((a, b) => a.created_at - b.created_at);

  for (const part of conversationParts) {
    // Skip the initial message if it's duplicated in parts and already processed via conversation.source
    // This check might need refinement based on how Intercom structures `source` vs `conversation_parts`
    if (conversation.source && part.id === conversation.source.id && part.type === 'conversation' && part.part_type === 'comment' && part.delivered_as === conversation.source.delivered_as) {
      // More specific check to avoid processing the initial customer message if it also appears as the first part.
      // This assumes the `source` object is the definitive first message.
      // console.log(`Skipping part ${part.id} as it appears to be the source message already processed.`);
      // continue; // Decided to keep this commented as Intercom's structure can vary.
                // Instead, we will rely on filtering out parts with no content below.
    }

    let messageBody = part.body || '';
    const hasAttachments = part.attachments && part.attachments.length > 0;

    // Skip rendering this part if it has no message body (after trimming) and no attachments
    if (messageBody.trim() === '' && !hasAttachments) {
      // console.log(`Skipping empty part ${part.id} by author ${part.author ? part.author.name : 'Unknown'}`);
      continue;
    }

    const isAdmin = part.author && (part.author.type === 'admin' || part.author.type === 'bot');
    let authorName = 'User';
    
    // Get the author's name if available
    if (part.author) {
      if (isAdmin && part.author.name) {
        authorName = part.author.name;
      } else if (!isAdmin && part.author.name) {
        authorName = part.author.name;
      } else if (part.author.email) {
        authorName = part.author.email.split('@')[0];
      }
    }
    
    const isNote = part.part_type === 'note';
    // Set colors for different message types
    const authorColor = isNote ? '#45380c' : (isAdmin ? '#30446c' : '#100c0c'); // Author name color (remains for text above bubble)
    const messageBgColor = isNote ? 'rgba(255, 243, 205, 0.9)' : (isAdmin ? '#30446c' : '#100c0c'); // Note: yellow, Admin: dark blue, User: dark gray/black
    const messageTextColor = isNote ? '#45380c' : '#FFFFFF'; // Note: dark yellow/brown text, Others: White text
    const loopTimestampColor = isNote ? '#45380c' : (isAdmin ? '#30446c' : '#100c0c'); // Same color as the chat bubble for better visibility
    const alignment = isAdmin ? 'right' : 'left';
    
    // Convert Unix timestamp to IST date string
    const date = new Date(part.created_at * 1000);
    const options = { 
      timeZone: 'Asia/Kolkata',
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false
    };
    const timeString = date.toLocaleString('en-IN', options).replace(',', '');
    
    // Clean the message body (remove HTML if needed)
    // messageBody is already defined from part.body at the start of the loop iteration
    if (messageBody.startsWith('<p>') && messageBody.endsWith('</p>')) {
      messageBody = messageBody.substring(3, messageBody.length - 4);
    }
    
    // Process inline images in the message body
    const imageExtractionResult = extractInlineImages(messageBody, globalInlineImageCounter);
    messageBody = imageExtractionResult.modifiedHtml;
    globalInlineImageCounter = imageExtractionResult.nextIndex;
    imageExtractionResult.extractedImages.forEach(img => {
      allAttachments.push({
        url: img.url,
        name: img.filename, // Sequential name
        content_type: 'image/' + img.filename.split('.').pop(),
        type: 'inline_image'
      });
    });
    
    // Replace inline image containers with a note about the image
    for (const img of imageExtractionResult.extractedImages) {
      console.log(`Replacing placeholder for image: ${img.filename}`);
      // Use a more targeted replacement approach to avoid regex issues
      try {
        // Since the placeholder might contain special regex characters, do a string replacement
        const placeholderIndex = messageBody.indexOf(`[Inline image: ${img.filename}]`);
        if (placeholderIndex !== -1) {
          // Replace just this occurrence
          messageBody = messageBody.substring(0, placeholderIndex) + 
                      `<strong>[ Inline image: ${img.filename} ]</strong>` + 
                      messageBody.substring(placeholderIndex + `[Inline image: ${img.filename}]`.length);
        } else {
          console.log('Could not find placeholder in message body');
        }
      } catch (error) {
        console.error('Error replacing image placeholder:', error);
      }
    }
    
    // Replace any [Image:...] patterns with a note
    messageBody = messageBody.replace(/\[Image:?\s*"?([^"\]]+)"?\]/g, (match, ref) => {
      return `<strong>[ Image reference ]</strong>`;
    });
    
    // Process standard attachments if any
    if (part.attachments && part.attachments.length > 0) {
      let attachmentText = '';
      
      // Add each attachment to the message body
      part.attachments.forEach(attachment => {
        const attachmentName = attachment.name || 'File';
        attachmentText += `<div><strong>[ Attachment: ${attachmentName} ]</strong></div>`;
        
        // Add to list of attachments to download
        allAttachments.push({
          url: attachment.url,
          name: attachment.name,
          content_type: attachment.content_type,
          type: 'attachment'
        });
      });
      
      // Append attachments text to message body
      if (attachmentText) {
        messageBody += (messageBody ? '<br>' : '') + attachmentText;
      }
    }
    
    // Check for attachment patterns and replace with attachment name
    if (messageBody.includes('[Attachment:')) {
      messageBody = messageBody.replace(/\[Attachment:(.+?)\]/g, '<strong>[ Attachment: $1 ]</strong>');
    }
    
    // Check for image patterns and replace with image name
    if (messageBody.includes('[Image')) {
      messageBody = messageBody.replace(/\[Image:?(.+?)\]/g, '<strong>[ Image: $1 ]</strong>');
    }
    
    html += `  <div style="margin-bottom: 16px; text-align: ${alignment};">\n`;
    html += `    <div style="color: ${authorColor}; font-weight: bold; margin-bottom: 2px;">${he.encode(authorName)}</div>\n`;
    html += `    <div style="background-color: ${messageBgColor}; color: ${messageTextColor}; padding: 10px 12px; border-radius: 8px; display: inline-block; max-width: 80%; margin-top: 4px; text-align: left; word-wrap: break-word;">\n`;
    html += `      ${messageBody}\n`; // messageBody is already processed for newlines and inline images
    html += `    </div>\n`;
    // Display attachments for this part, similar to how sourcePart handles them
    if (hasAttachments) {
      for (const att of part.attachments) {
        // Note: allAttachments.push() for API upload is handled earlier in the loop
        // Check if attachment reference already exists in the message body
        const encodedAttName = he.encode(att.name);
        const patternString = `\\[\\s*Attachment:\\s*${escapeRegExp(encodedAttName)}\\s*\\]`;
        const attachmentReferencePattern = new RegExp(patternString, 'i');
        if (!messageBody || !messageBody.match(attachmentReferencePattern)) {
          html += `    <div style="font-style: italic; font-size: 12px; color: ${loopTimestampColor}; margin-top: 4px; max-width: 80%; display: inline-block;"><em>[Attachment: ${encodedAttName}]</em></div>\n`;
        }
      }
    }
    html += `    <div style="font-size: 12px; color: ${loopTimestampColor}; margin-top: 4px;">${timeString}${isNote ? ' • Private Note' : ''}</div>\n`;
    html += `  </div>\n\n`;
  }
  html += '</body></html>';
  return { html, attachments: allAttachments };
}

// Function to add conversation transcript to ticket description
async function addConversationTranscriptToTicket(ticketData, conversationId) {
  if (!conversationId) {
    console.log('No conversation ID provided, skipping transcript');
    return ticketData;
  }
  
  try {
    // Fetch conversation details
    const conversation = await fetchIntercomConversation(conversationId);
    if (!conversation) {
      console.log('Could not fetch conversation, using original ticket data');
      return ticketData;
    }
    
    // Format the conversation as HTML and get attachments
    const { html: transcriptHtml, attachments } = await formatConversationAsHtml(conversation);
    console.log('Successfully generated conversation transcript');
    console.log(`Found ${attachments.length} attachments to process`);
    
    // Create the Intercom conversation URL in the standard format
    const intercomUrl = `${process.env.INTERCOM_INBOX_URL}/conversation/${conversationId}`;
    console.log('Intercom URL:', intercomUrl);
    
    // Clone ticket data to avoid modifying the original
    const updatedTicketData = {...ticketData};
    
    // Process attachments - download and store for form data
    if (attachments && attachments.length > 0) {
      if (!updatedTicketData._attachments) {
        updatedTicketData._attachments = [];
      }
      
      for (const attachment of attachments) {
        try {
          const fileBuffer = await downloadFile(attachment.url, attachment.name);
          if (fileBuffer) {
            updatedTicketData._attachments.push({
              name: attachment.name,
              content_type: attachment.content_type || 'application/octet-stream',
              buffer: fileBuffer
            });
            console.log(`Successfully processed attachment: ${attachment.name}`);
          }
        } catch (err) {
          console.error(`Failed to process attachment ${attachment.name}:`, err.message);
        }
      }
    }
    
    // Log current description for debugging
    console.log('Current description:', updatedTicketData.description);
    
    // Format with separate divs for better rendering in Freshdesk
    const urlSection = `
      <div>Chat Transcript Added</div>
      <div>Intercom Conversation URL: <a href="${intercomUrl}" rel="noreferrer">${intercomUrl}</a></div>
      <div>&nbsp;</div>
    `;
    
    // Build the final description
    let newDescription = '';
    
    if (updatedTicketData.description && updatedTicketData.description.includes('Chat Transcript Added')) {
      // If the default text is already there, replace it with our URL section
      newDescription = urlSection + transcriptHtml;
    } else {
      // If there's existing content, add our URL section and transcript
      newDescription = urlSection + (updatedTicketData.description || '') + '\n\n' + transcriptHtml;
    }
    
    console.log('New description excerpt (first 100 chars):', newDescription.substring(0, 100));

    // Update the ticket data with new description
    updatedTicketData.description = newDescription;
    
    return updatedTicketData;
  } catch (error) {
    console.error('Error adding conversation transcript:', error);
    return ticketData; // Return original data if there's an error
  }
}

// Helper function to create a Freshdesk ticket
async function createFreshdeskTicket(ticketData) {
  const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
  const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;
  
  try {
    // Extract conversation ID from ticket data if available
    let conversationId = null;
    if (ticketData._intercom_conversation_id) {
      conversationId = ticketData._intercom_conversation_id;
      // Remove our temporary field before sending to Freshdesk API
      delete ticketData._intercom_conversation_id;
    }
    
    // If conversation ID exists, add the URL to the description
    if (conversationId) {
      const intercomWorkspaceId = process.env.INTERCOM_WORKSPACE_ID;
      if (!intercomWorkspaceId) {
        console.warn('INTERCOM_WORKSPACE_ID is not set. Intercom conversation URL might be incomplete.');
      }
      const intercomConversationUrl = `https://app.intercom.com/a/inbox/${intercomWorkspaceId || 'YOUR_WORKSPACE_ID'}/inbox/conversation/${conversationId}`;
      
      // Create the URL section in the exact format requested
      const urlSection = `Chat Transcript Added\n\nIntercom Conversation URL: ${intercomConversationUrl}\n\n`;
      
      // Add URL section at the beginning of the description
      if (ticketData.description && ticketData.description.includes('Chat Transcript Added')) {
        ticketData.description = ticketData.description.replace('Chat Transcript Added', urlSection.trim());
      } else {
        ticketData.description = urlSection + (ticketData.description || '');
      }
    }
    
    // Check if we have attachments to send
    const hasAttachments = ticketData._attachments && ticketData._attachments.length > 0;
    
    // Create FormData for multipart/form-data request if we have attachments
    if (hasAttachments) {
      const FormData = require('form-data');
      const form = new FormData();
      
      // Add ticket data fields to form
      for (const key in ticketData) {
        if (key !== '_attachments' && ticketData[key] !== undefined) {
          if (typeof ticketData[key] === 'object') {
            form.append(key, JSON.stringify(ticketData[key]));
          } else {
            form.append(key, ticketData[key]);
          }
        }
      }
      
      // Add attachments to form
      ticketData._attachments.forEach((attachment, index) => {
        form.append(`attachments[]`, Buffer.from(attachment.buffer), {
          filename: attachment.name,
          contentType: attachment.content_type
        });
      });
      
      // Make request with form data
      console.log(`Sending ticket with ${ticketData._attachments.length} attachments via multipart/form-data`);
      const response = await axios.post(
        `${FRESHDESK_DOMAIN}/api/v2/tickets`,
        form,
        {
          auth: {
            username: FRESHDESK_API_KEY,
            password: 'X'
          },
          headers: form.getHeaders()
        }
      );
      return response.data;
    } else {
      // If no attachments, use regular JSON request
      console.log('Sending ticket without attachments via JSON');
      const response = await axios.post(
        `${FRESHDESK_DOMAIN}/api/v2/tickets`,
        ticketData,
        {
          auth: {
            username: FRESHDESK_API_KEY,
            password: 'X'
          },
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    }
  } catch (error) {
    console.error('Error creating Freshdesk ticket:', error.response ? error.response.data : error.message);
    throw error;
  }
}

module.exports = {
  fetchIntercomConversation,
  formatConversationAsHtml,
  addConversationTranscriptToTicket,
  createFreshdeskTicket,
  downloadFile
};
