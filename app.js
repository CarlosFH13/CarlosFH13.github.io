/***** Multiplayer Chess Game Logic (Frontend-only) *****/

// Firebase configuration (replace with your own Firebase project config)
var firebaseConfig = {
  apiKey: "<YOUR_API_KEY>",
  authDomain: "<YOUR_AUTH_DOMAIN>",
  databaseURL: "<YOUR_DATABASE_URL>",
  projectId: "<YOUR_PROJECT_ID>",
  storageBucket: "<YOUR_STORAGE_BUCKET>",
  messagingSenderId: "<YOUR_SENDER_ID>",
  appId: "<YOUR_APP_ID>"
};
// Initialize Firebase
firebase.initializeApp(firebaseConfig);
// References to the database paths for game state
const db = firebase.database();
const playersRef = db.ref("players");  // will hold {p1: <id>, p2: <id>}
const fenRef = db.ref("fen");          // will hold current board state in FEN notation

// Game and board setup
var game = new Chess();    // Chess.js game state manager
var board;                 // Chessboard.js board instance
var myId = "user_" + Math.floor(Math.random() * 1e6);  // simple random user ID
var myRole = "spectator";  // role can be "player1", "player2", or "spectator"
var myColor = null;        // "white" or "black" for players, null for spectator
var cheatEnabled = false;  // whether cheat mode is unlocked for this user

// Define cheat mode password (players must enter this to unlock cheats)
const CHEAT_PASSWORD = "letmein";  // <--- change this to any secret code

// UI elements
const playBtn = document.getElementById("playBtn");
const cheatInput = document.getElementById("cheatInput");
const cheatBtn = document.getElementById("cheatBtn");
const statusEl = document.getElementById("status");

// ** Helper Functions for highlighting moves (used in cheat mode and normal mode) **
// Remove all highlight coloring from squares
function removeHighlights() {
  // Chessboard.js squares have a class "square-55d63" for the board background
  $("#board .square-55d63").css("background", "");
}
// Highlight a particular square (give it a colored background)
function highlightSquare(square) {
  const $squareEl = $("#board .square-" + square);
  let highlightColor = "#a9a9a9";  // light gray by default
  // Chessboard.js assigns classes "black-3c85d" or "white-3c85d" to squares based on their color
  if ($squareEl.hasClass("black-3c85d")) {
    highlightColor = "#696969";  // darker gray on dark squares for contrast
  }
  $squareEl.css("background", highlightColor);
}

// ** Chessboard Event Handlers **

// onDragStart: Prevents dragging of pieces when not allowed
function onDragStart(source, piece, position, orientation) {
  if (game.game_over()) {
    return false;  // do not allow moves if game is over (checkmate or draw)
  }
  // If cheat mode is not enabled, enforce turn-based and role-based moves
  if (!cheatEnabled) {
    // Only players can move (spectators cannot drag)
    if (myRole !== "player1" && myRole !== "player2") return false;
    // Prevent moving opponent's pieces:
    if (myRole === "player1" && piece.search(/^b/) !== -1) return false;  // White player trying to move Black piece
    if (myRole === "player2" && piece.search(/^w/) !== -1) return false;  // Black player trying to move White piece
    // Prevent moving if it's not your turn:
    if (myRole === "player1" && game.turn() !== 'w') return false;
    if (myRole === "player2" && game.turn() !== 'b') return false;
  }
  // If cheatEnabled, any piece can be dragged at any time (no restrictions)
  // (We still implicitly block dragging if no piece: but source always has a piece when dragging starts)
  return true;
}

// onDrop: Handles piece drop events (attempt to make a move)
function onDrop(source, target) {
  removeHighlights();  // clear any highlighting when a piece is dropped

  let move = game.move({ from: source, to: target, promotion: 'q' });
  if (move === null) {
    // The move is illegal under standard rules
    if (cheatEnabled) {
      // Cheat mode: allow illegal move by force-moving the piece
      const movingPiece = game.get(source); // get the piece object at source
      if (movingPiece) {
        game.remove(source);        // remove piece from source square
        game.remove(target);        // remove any piece on target (capture if present)
        game.put(movingPiece, target); // put the moving piece on the target square
        // For cheat moves, we manually switch turn to the other player, treating it as a completed move
        game._turn = (game._turn === 'w' ? 'b' : 'w');  // ** Hack:** flip internal turn:contentReference[oaicite:0]{index=0}
      }
    } else {
      // Non-cheat mode and illegal move: snap the piece back to original square
      return 'snapback';
    }
  }
  // If a legal move was made (or a cheat move was processed), update the game state
  updateStatus();           // update game status text (turn, check, etc.)
  syncGameState();          // sync the new board state to the database
  // The Chessboard.js library will move the piece on the board visually.
  // Return undefined to indicate the move was handled (no snapback needed).
}

// onMouseoverSquare: Highlight legal moves for the piece on this square (for assistance, esp. in cheat mode)
function onMouseoverSquare(square, piece) {
  // Only show move hints if cheat mode is enabled or it's the current player's turn (optional: always show for players)
  if (!cheatEnabled) {
    // If not cheat mode, optionally highlight only current player's piece moves (here we highlight for the side to move)
    if ((game.turn() === 'w' && piece && piece.search(/^w/) !== -1 && myRole === "player1") ||
        (game.turn() === 'b' && piece && piece.search(/^b/) !== -1 && myRole === "player2")) {
      var moves = game.moves({ square: square, verbose: true });
      if (moves.length === 0) return;
      // Highlight the square we are hovering
      highlightSquare(square);
      // Highlight all possible moves from that square
      moves.forEach(m => highlightSquare(m.to));
    }
    return;
  }
  // In cheat mode: show legal moves for any piece (both colors, regardless of turn)
  if (!piece) return;
  let moves = game.moves({ square: square, verbose: true });
  // If no moves because it's not that side's turn, temporarily flip turn to get moves:contentReference[oaicite:1]{index=1}
  if (moves.length === 0) {
    const savedTurn = game.turn();
    const pieceColor = (piece.search(/^w/) !== -1) ? 'w' : 'b';
    if (pieceColor !== savedTurn) {
      // Temporarily set turn to the piece's color and get moves
      game._turn = pieceColor;
      moves = game.moves({ square: square, verbose: true });
      game._turn = savedTurn;
    }
  }
  if (moves.length === 0) return;
  highlightSquare(square);
  moves.forEach(m => highlightSquare(m.to));
}

// onMouseoutSquare: Remove highlights when mouse leaves a square
function onMouseoutSquare(square, piece) {
  removeHighlights();
}

// onSnapEnd: After piece snap (animation complete), ensure board position is correct
function onSnapEnd() {
  // This event fires after a piece has finished moving (animation).
  // Sync the board UI with the internal game state in case it drifted.
  board.position(game.fen());
}

// ** Initialize the chessboard UI **
board = ChessBoard('board', {
  draggable: true,
  position: 'start',
  orientation: 'white',  // default orientation (will adjust if player is black)
  pieceTheme: 'https://cdn.jsdelivr.net/gh/oakmac/chessboardjs@master/website/img/chesspieces/wikipedia/{piece}.png',  // use Wikipedia chess pieces images
  onDragStart: onDragStart,
  onDrop: onDrop,
  onMouseoverSquare: onMouseoverSquare,
  onMouseoutSquare: onMouseoutSquare,
  onSnapEnd: onSnapEnd
});

// ** Firebase Realtime Database Handlers **

// Sync the local state to the database (update FEN and any other info)
function syncGameState() {
  const fen = game.fen();
  fenRef.set(fen);  // publish the new board state to Firebase
}

// Listen for changes in game state (fen) from the database
fenRef.on("value", snapshot => {
  const fen = snapshot.val();
  if (!fen) return;  // if fen is null (not set yet), do nothing
  // If this client is the one who made the last move, our game state is already up to date.
  // We can skip re-loading if the FEN is identical to avoid redundant work.
  if (fen === game.fen()) {
    return;
  }
  // Load the new board state from FEN
  game.load(fen);
  board.position(fen);  // update the board UI to this state
  updateStatus();       // update turn display and game status
});

// Listen for changes in the players list (to handle role assignment and late joiners)
playersRef.on("value", snapshot => {
  const players = snapshot.val() || {};
  const p1 = players.p1 || null;
  const p2 = players.p2 || null;
  // Update UI based on current players
  if (p1 && p2) {
    // Two players present
    if (myRole === "spectator") {
      // I'm not a player and two are playing, disable the Play button
      playBtn.disabled = true;
      playBtn.textContent = "Spectating";
    }
  } else {
    // Less than 2 players
    playBtn.disabled = false;
    playBtn.textContent = "Play";
  }
  // If I am assigned as a player, but my ID is no longer in players (someone replaced me?), set to spectator
  if ((myRole === "player1" && p1 !== myId) || (myRole === "player2" && p2 !== myId)) {
    myRole = "spectator";
    myColor = null;
  }
  updateStatus();  // update status text to reflect any role changes
});

// ** UI Event Listeners **

// Handle "Play" button click: attempt to become a player
playBtn.addEventListener("click", () => {
  // If already a player, do nothing
  if (myRole === "player1" || myRole === "player2") return;
  // Attempt to claim a player slot via a transaction to avoid race conditions
  playersRef.transaction(current => {
    if (current === null) current = {};
    if (!current.p1) {
      current.p1 = myId;
      myRole = "player1";
      myColor = "white";
    } else if (!current.p2) {
      current.p2 = myId;
      myRole = "player2";
      myColor = "black";
    } else {
      // Both slots full
      return;  // abort transaction (no change)
    }
    return current;
  }, (error, committed, snapshot) => {
    if (!committed || !snapshot) {
      // Transaction failed (likely because slots filled by someone else)
      myRole = "spectator";
      myColor = null;
      updateStatus();
    } else {
      // Successfully became a player
      updateStatus();
      // Set board orientation: flip for black player
      if (myRole === "player2") {
        board.orientation('black');
      } else {
        board.orientation('white');
      }
      // Ensure initial board state is synced (if joining mid-game, load current state)
      fenRef.once("value").then(snap => {
        const fen = snap.val();
        if (fen) {
          game.load(fen);
          board.position(fen);
        } else {
          // If no game state yet (first player joining), initialize with starting position
          const startFen = game.fen(); // should be initial position
          fenRef.set(startFen);
        }
        updateStatus();
      });
      // Set up onDisconnect to free the player slot automatically if this user leaves
      const slot = (myRole === "player1") ? 'p1' : 'p2';
      playersRef.child(slot).onDisconnect().remove();
    }
  });
});

// Handle cheat code unlock button
cheatBtn.addEventListener("click", () => {
  const code = cheatInput.value;
  if (code === CHEAT_PASSWORD) {
    cheatEnabled = true;
    document.body.classList.add("cheat-active");
    // Provide visual feedback that cheat mode is enabled (e.g., update status or disable input)
    cheatInput.disabled = true;
    cheatBtn.disabled = true;
    cheatBtn.textContent = "Cheats On";
    updateStatus();
  } else {
    alert("Incorrect password for cheat mode.");
    cheatInput.value = "";
  }
});

// (Optional) Also allow pressing Enter to submit cheat password
cheatInput.addEventListener("keyup", (e) => {
  if (e.key === "Enter") {
    cheatBtn.click();
  }
});

// ** Game Status Update ** 
function updateStatus() {
  let statusText = "";
  // Identify players in text
  if (myRole === "player1") {
    statusText += "You are Player1 (White).\n";
  } else if (myRole === "player2") {
    statusText += "You are Player2 (Black).\n";
  } else {
    statusText += "You are a Spectator.\n";
  }
  if (cheatEnabled) {
    statusText += "Cheat mode ACTIVATED.\n";
  }
  // Game state and turn information
  if (game.game_over()) {
    if (game.in_checkmate()) {
      // If game is over by checkmate, the side who has no moves is game.turn()
      const winner = (game.turn() === 'w') ? "Black" : "White";
      statusText += `Game Over – ${winner} wins by checkmate.`;
    } else if (game.in_stalemate()) {
      statusText += "Game Over – Draw (stalemate).";
    } else if (game.in_threefold_repetition()) {
      statusText += "Game Over – Draw (threefold repetition).";
    } else if (game.insufficient_material()) {
      statusText += "Game Over – Draw (insufficient material).";
    } else if (game.in_draw()) {
      statusText += "Game Over – Draw.";
    } else {
      statusText += "Game Over.";
    }
  } else {
    // Game not over: indicate whose turn
    const turn = game.turn() === 'w' ? "White" : "Black";
    statusText += `${turn} to move.`;
    // Indicate if the current player is in check
    if (game.in_check()) {
      statusText += ` ${turn} is in check!`;
    }
  }
  statusEl.textContent = statusText;
}

// Initial status update call
updateStatus();

// Initial setup: get current game state from DB so late joiners see the existing game
fenRef.once("value").then(snapshot => {
  const fen = snapshot.val();
  if (fen) {
    game.load(fen);
    board.position(fen);
  }
  updateStatus();
});
