import { RideableFlags } from "./helpers/RideableFlags.js";
import { GeometricUtils } from "./utils/GeometricUtils.js";
import { RideableUtils, cModuleName } from "./utils/RideableUtils.js";
import { RideablePopups } from "./helpers/RideablePopups.js";

const cComfortBacklog = 2; //grid spaces of acceptable trailing backlog before a follower speeds up to catch up
const cMaxSpeedFactor = 4; //maximum multiple of the default movement speed a follower will use to catch up
const cMaxChainDepth = 10; //safety net against follow cycles (module options are broadcast, so this guards moveToken re-entrancy)
const cFormationWidth = 3; //columns per row when spreading multiple direct followers of one leader (see computePeerOffsets)

//Per-follower latest-wins latch: follower id -> {running: Promise|null, dirty: boolean, context: object}
//Replaces the old recursion-guard Set + per-follower queue: a move already in flight just gets
//marked dirty and re-run once against the freshest history when it completes, so nothing is dropped.
let vFollowerLatches = new Map();

// Size-aware clearance: if follower would overlap leader's new bounding box, push it outward.
// Uses Math.max(width, height) to handle non-square tokens conservatively.
// Returns adjusted {x, y} top-left position for the follower, or null if no adjustment needed.
function applyClearanceOffset(pTargetPosition, pFollower, pLeaderNewPosition, pTarget) {
	let vFolCenterX = pTargetPosition.x + GeometricUtils.insceneWidth(pFollower) / 2;
	let vFolCenterY = pTargetPosition.y + GeometricUtils.insceneHeight(pFollower) / 2;
	let vDx = vFolCenterX - pLeaderNewPosition.x;
	let vDy = vFolCenterY - pLeaderNewPosition.y;
	let vDist = Math.sqrt(vDx * vDx + vDy * vDy);
	let vMinDist = (Math.max(GeometricUtils.insceneWidth(pTarget), GeometricUtils.insceneHeight(pTarget))
		+ Math.max(GeometricUtils.insceneWidth(pFollower), GeometricUtils.insceneHeight(pFollower))) / 2;
	if (vDist < vMinDist && vDist > 0.5) {
		let vScale = vMinDist / vDist;
		let vAdjusted = GeometricUtils.CentertoXY({
			x: pLeaderNewPosition.x + vDx * vScale,
			y: pLeaderNewPosition.y + vDy * vScale
		}, pFollower);
		return { x: vAdjusted.x, y: vAdjusted.y };
	}
	return null;
}

class FollowingManager {
	//DECLARATIONS
	static FollowingActive() {} //returns if the token following feature is active

	static async FollowToken(pFollowers, pTarget, pDistance = -1, pSourcePlayerID = null) {} //sets pFollowers to follow pTarget

	static async StopFollowing(pFollowers, pPopup = true) {} //stops pFollowers from following

	static RequestFollowToken(pFollowers, pTarget, pDistance = -1) {} //sends follow request to GM via socket

	static FollowTokenRequest({pFollowerIDs, pTargetID, pSceneID, pDistance, pRequestingPlayerID} = {}) {} //GM-only handler for follow request

	static RequestStopFollowing(pFollowers, pPopup = true) {} //sends stop-follow request to GM via socket

	static StopFollowingRequest({pFollowerIDs, pSceneID, pPopup, pRequestingPlayerID} = {}) {} //GM-only handler for stop-follow request

	static async SelectedFollowHovered(pConsiderTargeted = true, pDistance = -1) {} //lets the selected tokens follow the hovered token

	static async SelectedStopFollowing(pPopup = true) {} //makes the selected tokens stop following

	static async SelectedToggleFollwing(pConsiderTargeted = true, pDistance = -1) {} //toggles the selected tokens regarding following

	static requestAdvance(pFollower, pTarget, pContext) {} //queues/executes the next movement step for pFollower via the latest-wins latch

	static async advanceFollower(pFollower, pTarget, pContext) {} //moves pFollower one step to the leader's pre-move position (a "conga line" step)

	static computePeerOffsets(pFollowers, pGrid, pDirection, pTarget, pBaseCenter) {} //assigns each of pFollowers a size-aware deterministic spread offset (perpendicular/behind pDirection); followers whose formation slot is wall-blocked from their current position funnel into a single-file queue behind pBaseCenter, or hold (null offset) if even that is unreachable

	static async OnTokenmove(pToken, pMovement, pOperation, pUser) {} //called for every token that finished a movement operation

	static OnCombatantUpdate(pCombatant) {} //called when a combatant is created/deleted

	static async OnCanvasReady(pCanvas) {} //called when a new canvas is readied

	static OnStartFollowing(pToken, pFollowed, pPopup = true) {} //called when pToken starts following

	static OnStopFollowing(pToken, pPopup = true) {} //called wehn pToken stops following

	//IMPLEMENTATIONS
	static FollowingActive() {
		return game.settings.get(cModuleName, "EnableFollowing");
	}

	static async FollowToken(pFollowers, pTarget, pDistance = -1, pSourcePlayerID = null) {
		// Route through GM if current user is not GM
		if (!game.user.isGM) {
			FollowingManager.RequestFollowToken(pFollowers, pTarget, pDistance);
			return;
		}

		let vFollowers = pFollowers.filter(vFollower => (vFollower != pTarget));

		for (let i = 0; i < vFollowers.length; i++) {
			if (RideableFlags.isFollowingToken(pTarget, vFollowers[i])) {
				RideablePopups.TextPopUpID(vFollowers[i] ,"TargetisFollowingMe", {pFollowedName : RideableFlags.RideableName(pTarget)}, {type : "error"}); //MESSAGE POPUP
			}
		}
		vFollowers = vFollowers.filter(vFollower => !RideableFlags.isFollowingToken(pTarget, vFollower));

		let vDistance;
		let vDefaultDistance = pDistance;

		for (let i = 0; i < vFollowers.length; i++) {
			if (!vFollowers[i].inCombat || game.settings.get(cModuleName, "FollowingCombatBehaviour") == "continue") {
				if (vDefaultDistance >= 0) {
					vDistance = vDefaultDistance;
				}
				else {
					vDistance = GeometricUtils.TokenDistance(vFollowers[i], pTarget);
				}

				// Determine which client should be responsible for processing this following
				// relationship. Prefer an active non-GM player who owns the follower so their client
				// handles movement even when the GM is on a different scene. Fall back to
				// the GM's ID for NPC/unowned tokens or if the owning player is offline — those
				// still require a GM to be present.
				let vEffectiveSourceID = game.userId;
				let vFollowerOwnership = vFollowers[i].ownership ?? {};
				// Check the explicit requester first (if any)
				if (pSourcePlayerID && game.users.get(pSourcePlayerID)?.active && (vFollowerOwnership[pSourcePlayerID] ?? vFollowerOwnership["default"] ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
					vEffectiveSourceID = pSourcePlayerID;
				}
				else {
					// Otherwise find any active non-GM player with Owner permission on this token
					for (let [vUserID, vLevel] of Object.entries(vFollowerOwnership)) {
						if (vUserID !== "default" && vLevel >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
							let vUser = game.users.get(vUserID);
							if (vUser && vUser.active && !vUser.isGM) {
								vEffectiveSourceID = vUserID;
								break;
							}
						}
					}
				}
				await RideableFlags.startFollowing(vFollowers[i], pTarget, vDistance, vEffectiveSourceID);

				FollowingManager.OnStartFollowing(vFollowers[i], pTarget);
			}
			else {
				RideablePopups.TextPopUpID(vFollowers[i], "CantFollowinCombat", {}, {type : "error"}); //MESSAGE POPUP
			}
		}

		// Don't immediately calculate routes - followers will move when the target moves
	}

	static RequestFollowToken(pFollowers, pTarget, pDistance = -1) {
		// Send request to GM via socket
		if (!game.paused && pFollowers.length && pTarget) {
			game.socket.emit("module."+cModuleName, {
				pFunction: "FollowTokenRequest",
				pData: {
					pFollowerIDs: RideableUtils.IDsfromTokens(pFollowers),
					pTargetID: pTarget.id,
					pSceneID: pTarget.parent.id,
					pDistance: pDistance,
					pRequestingPlayerID: game.userId
				}
			});
		}
	}

	static FollowTokenRequest({pFollowerIDs, pTargetID, pSceneID, pDistance, pRequestingPlayerID} = {}) {
		// Only GM processes this request
		if (game.user.isGM) {
			let vScene = game.scenes.get(pSceneID);
			let vFollowers = RideableUtils.TokensfromIDs(pFollowerIDs, vScene);
			let vTarget = RideableUtils.TokenfromID(pTargetID, vScene);

			if (pRequestingPlayerID) {
				let vRequester = game.users.get(pRequestingPlayerID);
				vFollowers = vFollowers.filter(vFollower => vFollower.testUserPermission(vRequester, "OWNER"));
			}

			if (vFollowers.length && vTarget) {
				FollowingManager.FollowToken(vFollowers, vTarget, pDistance, pRequestingPlayerID);
			}
		}
	}

	static RequestStopFollowing(pFollowers, pPopup = true) {
		// Send request to GM via socket
		if (!game.paused && pFollowers.length) {
			game.socket.emit("module."+cModuleName, {
				pFunction: "StopFollowingRequest",
				pData: {
					pFollowerIDs: RideableUtils.IDsfromTokens(pFollowers),
					pSceneID: pFollowers[0].parent.id,
					pPopup: pPopup,
					pRequestingPlayerID: game.userId
				}
			});
		}
	}

	static StopFollowingRequest({pFollowerIDs, pSceneID, pPopup, pRequestingPlayerID} = {}) {
		// Only GM processes this request
		if (game.user.isGM) {
			let vScene = game.scenes.get(pSceneID);
			let vFollowers = RideableUtils.TokensfromIDs(pFollowerIDs, vScene);

			if (pRequestingPlayerID) {
				let vRequester = game.users.get(pRequestingPlayerID);
				vFollowers = vFollowers.filter(vFollower => vFollower.testUserPermission(vRequester, "OWNER"));
			}

			if (vFollowers.length) {
				FollowingManager.StopFollowing(vFollowers, pPopup);
			}
		}
	}

	static async StopFollowing(pFollowers, pPopup = true) {
		// Route through GM if current user is not GM
		if (!game.user.isGM) {
			FollowingManager.RequestStopFollowing(pFollowers, pPopup);
			return;
		}

		for (let i = 0; i < pFollowers.length; i++) {
			if (RideableFlags.isFollowing(pFollowers[i])) {
				await RideableFlags.stopFollowing(pFollowers[i]);

				// Clear any pending latch for this follower
				vFollowerLatches.delete(pFollowers[i].id);

				FollowingManager.OnStopFollowing(pFollowers[i], pPopup);
			}
		}
	}

	static async SelectedFollowHovered(pConsiderTargeted = true, pDistance = -1) {
		if (FollowingManager.FollowingActive()) {
			let vFollowers = RideableUtils.selectedTokens();

			let vTarget = RideableUtils.hoveredRideableToken();

			if (!vTarget && pConsiderTargeted) {
				vTarget = RideableUtils.targetedTokens()[0];
			}

			if (vFollowers.length > 0 && vTarget) {
				await FollowingManager.FollowToken(vFollowers, vTarget, pDistance);
			}
		}
	}

	static async SelectedStopFollowing(pPopup = true) {
		if (FollowingManager.FollowingActive()) {
			let vFollowers = RideableUtils.selectedTokens();

			FollowingManager.StopFollowing(vFollowers, pPopup);
		}
	}

	static async SelectedToggleFollwing(pConsiderTargeted = true, pDistance = -1) {
		if (FollowingManager.FollowingActive()) {
			let vTarget = RideableUtils.hoveredRideableToken();

			if (!vTarget && pConsiderTargeted) {
				vTarget = RideableUtils.targetedTokens()[0];
			}

			let vSelected = RideableUtils.selectedTokens();

			let vPreFollowers = [];

			if (vTarget) {
				vPreFollowers = vSelected.filter(vToken => RideableFlags.isFollowingToken(vToken, vTarget));
			}
			else {
				vPreFollowers = vSelected;
			}

			let vPostFollowers = vSelected.filter(vToken => !vPreFollowers.includes(vToken));

			if (vPreFollowers.length && !vPostFollowers.length) {
				FollowingManager.StopFollowing(vPreFollowers);
			}

			if (vTarget && vPostFollowers.length) {
				await FollowingManager.FollowToken(vPostFollowers, vTarget, pDistance);
			}
		}
	}

	static requestAdvance(pFollower, pTarget, pContext) {
		let vLatch = vFollowerLatches.get(pFollower.id) ?? {running: null, dirty: false, context: null};
		vLatch.context = pContext; // latest wins

		if (vLatch.running) {
			vLatch.dirty = true;
			vFollowerLatches.set(pFollower.id, vLatch);
			return;
		}

		vLatch.running = (async () => {
			try {
				do {
					vLatch.dirty = false;
					await FollowingManager.advanceFollower(pFollower, pTarget, vLatch.context);
				} while (vLatch.dirty);
			}
			finally {
				vFollowerLatches.delete(pFollower.id);
			}
		})();

		vFollowerLatches.set(pFollower.id, vLatch);
	}

	static async advanceFollower(pFollower, pTarget, pContext) {
		// Single-step "conga line" move: go directly to where pTarget was immediately before
		// this move (pContext.OldCenter), computed fresh from this event's own before/after
		// positions - never from a persisted route or index. This is deliberately simple:
		// whatever the follower's current position is, it always ends up exactly one step
		// behind wherever the leader currently is, and a chain (A<-B<-C) cascades correctly
		// because each link's own move re-triggers this for whichever tokens follow *it*.
		let vTargetCenter = {x: pContext.OldCenter.x, y: pContext.OldCenter.y};

		if (pContext.PeerOffset) {
			vTargetCenter.x += pContext.PeerOffset.x;
			vTargetCenter.y += pContext.PeerOffset.y;
		}

		let vBase = GeometricUtils.CentertoXY(vTargetCenter, pFollower);

		// Push away from the leader's post-move footprint if the two would overlap
		let vClearance = applyClearanceOffset(vBase, pFollower, pContext.NewCenter, pTarget);
		let vFinal = vClearance ?? vBase;

		if (game.settings.get(cModuleName, "FollowingGridSnap") && pFollower.parent.grid?.type > 0) {
			vFinal = GeometricUtils.GridSnapxy({x: vFinal.x, y: vFinal.y}, pFollower.parent.grid);
		}

		let vWaypoint = {x: vFinal.x, y: vFinal.y, snapped: false};

		if (pContext.Teleport) {
			vWaypoint.action = "displace";
		}

		switch (game.settings.get(cModuleName, "FollowerElevation")) {
			case "ignore":
				vWaypoint.elevation = pFollower.elevation;
				break;
			case "delta":
				vWaypoint.elevation = pFollower.elevation + ((pContext.NewCenter.elevation ?? 0) - (pContext.OldCenter.elevation ?? 0));
				break;
			case "leader":
			default:
				vWaypoint.elevation = pContext.OldCenter.elevation;
				break;
		}

		let vMoveOptions = {
			showRuler: false,
			autoRotate: false,
			RideableFollowingMovement: true,
			RidingMovement: pContext.RidingMovement,
			RideableFollowChainDepth: (pContext.Depth ?? 0) + 1
		};

		// Speed: by default DON'T force an animation speed, so the follower glides at its own
		// natural rate (whatever the game system / movement module derives from its movement
		// stat via Token#_getAnimationMovementSpeed). This keeps a 15ft follower in lockstep
		// with a 15ft leader instead of always racing at the engine default. Only override the
		// speed when the follower has a real gap to close (long or rapid leader movement), and
		// scale that boost relative to the follower's own natural speed rather than a fixed
		// default so slow tokens still catch up at a proportional pace.
		let vFollowerCenter = pFollower.object?.center ?? GeometricUtils.CenterPositionXY(pFollower);
		let vGrid = pFollower.parent.grid;
		let vBacklogSpaces = vGrid?.size ? GeometricUtils.DistanceXY(vFollowerCenter, vTargetCenter) / vGrid.size : 1;
		let vCatchupFactor = Math.min(cMaxSpeedFactor, Math.max(1, vBacklogSpaces / cComfortBacklog));

		if (vCatchupFactor > 1 && !pContext.Teleport) {
			let vNaturalSpeed = pFollower.object?._getAnimationMovementSpeed?.({}) ?? CONFIG.Token.movement.defaultSpeed;
			vMoveOptions.animation = {movementSpeed: vNaturalSpeed * vCatchupFactor};
		}

		// Whether this move got stopped short by a wall (a formation spread too wide for a
		// corridor, or a follower too large to fit somewhere its leader could) is detected from
		// Foundry's own "constrained" signal on the resulting moveToken event, not by comparing
		// coordinates here - see OnTokenmove.
		await pFollower.move([vWaypoint], vMoveOptions);
	}

	static computePeerOffsets(pFollowers, pGrid, pDirection, pTarget, pBaseCenter) {
		// Deterministic grid formation so multiple direct followers of the same leader don't all
		// pile onto the exact same vacated cell - or onto the leader itself, or onto each other.
		// Columns run along the axis PERPENDICULAR to the leader's direction of travel; rows run
		// along the axis directly BEHIND it (the negative of its travel direction), wrapping into a
		// new row every cFormationWidth followers instead of growing into one ever-wider line.
		// Because every row offset is zero-or-negative along the travel axis, no follower's
		// assigned spot can ever coincide with the leader's own new position, regardless of which
		// way it moved or how many followers there are. The common case (a simple chain, one
		// follower per link) never exercises this - each batch here has exactly one entry and gets
		// no offset.
		let vOffsets = new Map();

		if (pFollowers.length <= 1) {
			if (pFollowers.length === 1) vOffsets.set(pFollowers[0].id, {x: 0, y: 0});
			return vOffsets;
		}

		let vSorted = [...pFollowers].sort((a, b) => a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));

		// Size-aware spacing: lanes/rows must be at least as wide as the largest follower's own
		// footprint in this batch, so same-size followers spaced one lane/row apart never overlap
		// each other. Snapped up to a whole number of grid cells so the formation stays grid-aligned.
		let vFollowerSize = Math.max(...pFollowers.map(vFollower => Math.max(GeometricUtils.insceneWidth(vFollower), GeometricUtils.insceneHeight(vFollower))));
		let vGridSize = pGrid?.size;
		let vStep = vGridSize ? Math.ceil(vFollowerSize / vGridSize) * vGridSize : vFollowerSize;

		let vDirLength = Math.sqrt(pDirection.x * pDirection.x + pDirection.y * pDirection.y) || 1;
		let vForward = {x: pDirection.x / vDirLength, y: pDirection.y / vDirLength};
		let vPerp = {x: -vForward.y, y: vForward.x};

		// If the leader is large relative to how far it just moved, the plain "one step behind"
		// base spot (the same spot a lone follower or chain link uses) can still sit inside or
		// right up against its new footprint. Push the WHOLE formation uniformly further back
		// until it clears the leader - uniformly, so every lane in a row stays in a straight line,
		// instead of leaving it to the per-follower clearance push to shove different lanes by
		// different amounts (which is what made things look chaotic with a large leader).
		let vExtraBackward = 0;
		if (pTarget) {
			let vLeaderSize = Math.max(GeometricUtils.insceneWidth(pTarget), GeometricUtils.insceneHeight(pTarget));
			let vRequiredClearance = (vLeaderSize + vFollowerSize) / 2;
			vExtraBackward = Math.max(0, vRequiredClearance - vDirLength);
			if (vGridSize) vExtraBackward = Math.ceil(vExtraBackward / vGridSize) * vGridSize;
		}

		// Wall handling works per follower, on the question that actually decides success: "can
		// THIS follower get from where it currently stands to the slot being assigned to it?"
		// Earlier iterations instead probed the geometry around the DESTINATION (are the side
		// lanes clear of the trailing spot / the leader) - which fails at an ordinary doorway:
		// one step after the leader passes through, the trailing spot and all lanes sit in the
		// wide-open interior and look perfectly clear, while the followers are still standing
		// outside with a solid wall between them and every slot except the one aligned with the
		// gap. The straight-line center test below matches how Foundry itself constrains token
		// movement, so "ray is clear" and "the move will actually complete" agree.
		//
		// Fallbacks when a follower's formation slot is unreachable:
		// 1. Funnel: take the next free spot in a single-file queue strung BACKWARD from the
		//    trailing spot along the leader's line of travel. Those spots trace the leader's own
		//    recent path - the one line guaranteed to thread whatever gap the leader just walked
		//    through. This is what makes a formation pour through a doorway one-by-one and fan
		//    back out on the far side, and it also covers narrow alleys and corners (side slots
		//    there are wall-blocked from behind too, so everyone queues into single file).
		// 2. Hold: if even the queue spot is unreachable, assign null - the follower simply
		//    doesn't move this step (instead of slamming into the wall and triggering the
		//    constrained-movement stop-following logic) and retries on the leader's next move,
		//    by which point the queue has usually advanced enough to open a spot it can reach.
		//
		// Reachability needs live scene geometry, so when driving a token on a scene other than
		// the one currently viewed, plain full-width offsets are assigned unchecked (previous
		// behavior).
		let vCanTestWalls = Boolean(pBaseCenter) && canvas.scene?.id === pTarget?.parent?.id;
		let visBlocked = (pFrom, pTo) => CONFIG.Canvas.polygonBackends["move"].testCollision(pFrom, pTo, {type: "move", mode: "any"});

		let vAssignedCenters = [];
		let vQueueDepth = 0;
		let vMaxQueueDepth = pFollowers.length + 4;

		vSorted.forEach((vFollower, i) => {
			let vRow = Math.floor(i / cFormationWidth);
			let vCol = i % cFormationWidth;
			// Column sequence 0, -1, +1, -2, +2, ... within each row: centered, fanning out to
			// alternating sides rather than growing off to one edge.
			let vLane = Math.ceil(vCol / 2) * (vCol % 2 === 0 ? 1 : -1);
			let vBackward = vRow * vStep + vExtraBackward;

			let vOffset = {
				x: vPerp.x * vLane * vStep - vForward.x * vBackward,
				y: vPerp.y * vLane * vStep - vForward.y * vBackward
			};

			if (!vCanTestWalls) {
				vOffsets.set(vFollower.id, vOffset);
				return;
			}

			let vFollowerCenter = GeometricUtils.CenterPositionXY(vFollower);
			let vSlotCenter = {x: pBaseCenter.x + vOffset.x, y: pBaseCenter.y + vOffset.y};

			if (!visBlocked(vFollowerCenter, vSlotCenter)) {
				vOffsets.set(vFollower.id, vOffset);
				vAssignedCenters.push(vSlotCenter);
				return;
			}

			// Funnel queue: next free, reachable spot straight back from the trailing spot
			while (vQueueDepth <= vMaxQueueDepth) {
				let vQueueBackward = vExtraBackward + vQueueDepth * vStep;
				let vQueueCenter = {x: pBaseCenter.x - vForward.x * vQueueBackward, y: pBaseCenter.y - vForward.y * vQueueBackward};
				vQueueDepth++;

				if (vAssignedCenters.some(vCenter => GeometricUtils.DistanceXY(vCenter, vQueueCenter) < vStep * 0.75)) {
					continue; // spot already taken by a slotted or queued peer
				}

				if (visBlocked(vFollowerCenter, vQueueCenter)) {
					continue; // deeper queue spots are further back toward the follower's side - keep looking
				}

				vOffsets.set(vFollower.id, {x: vQueueCenter.x - pBaseCenter.x, y: vQueueCenter.y - pBaseCenter.y});
				vAssignedCenters.push(vQueueCenter);
				return;
			}

			vOffsets.set(vFollower.id, null); // hold in place this step, retry on the leader's next move
		});

		return vOffsets;
	}

	static async OnTokenmove(pToken, pMovement, pOperation, pUser) {
		let vDepth = pOperation.RideableFollowChainDepth ?? 0;

		if (vDepth > cMaxChainDepth) return; // cycle safety net (module options are broadcast to all clients)

		// If this move was one WE drove (a follow/grapple step, see advanceFollower) and Foundry
		// had to stop it short of its intended destination - a wall in the way, a formation spread
		// too wide for a corridor, or simply a follower too large to fit somewhere its leader
		// could - stop following cleanly instead of leaving the token stuck at the obstacle
		// indefinitely. This uses Foundry's own authoritative "was this movement constrained"
		// signal rather than comparing coordinates ourselves: Foundry's snapping/rounding pipeline
		// doesn't guarantee a move lands on the exact floating-point position requested even when
		// nothing blocked it, so a coordinate comparison flagged ordinary successful moves as
		// "stuck" as often as genuinely blocked ones.
		if (pOperation.RideableFollowingMovement && pMovement.constrained
			&& pToken.isOwner && RideableFlags.isFollowing(pToken) && RideableFlags.isFollowOrderSource(pToken)) {
			await FollowingManager.StopFollowing([pToken]);
		}

		let vPositionChanged = pMovement.origin.x !== pMovement.destination.x || pMovement.origin.y !== pMovement.destination.y;

		if (!vPositionChanged) return;

		let vLastAction = pMovement.passed.waypoints.at(-1)?.action;
		let vTeleport = Boolean(CONFIG.Token.movement.actions[vLastAction]?.teleport) || pOperation.animate === false;

		let vOldCenter = {
			x: pMovement.origin.x + GeometricUtils.insceneWidth(pToken) / 2,
			y: pMovement.origin.y + GeometricUtils.insceneHeight(pToken) / 2,
			elevation: pMovement.origin.elevation
		};
		let vNewCenter = {
			x: pMovement.destination.x + GeometricUtils.insceneWidth(pToken) / 2,
			y: pMovement.destination.y + GeometricUtils.insceneHeight(pToken) / 2,
			elevation: pMovement.destination.elevation
		};
		let vTravelDirection = {x: vNewCenter.x - vOldCenter.x, y: vNewCenter.y - vOldCenter.y};

		// 1) Drive followers this client is responsible for
		if (!(pToken.inCombat && ["stop-includefollowed", "resumeafter-includefollowed"].includes(game.settings.get(cModuleName, "FollowingCombatBehaviour")))) {
			if (pToken.object?.visible || !game.settings.get(cModuleName, "OnlyfollowViewed") || game.user.isGM) {
				let vFollowers = RideableFlags.followingTokens(pToken).filter(vToken => vToken.isOwner && RideableFlags.isFollowOrderSource(vToken));

				if (["stop", "stop-includefollowed", "resumeafter", "resumeafter-includefollowed"].includes(game.settings.get(cModuleName, "FollowingCombatBehaviour"))) {
					vFollowers = vFollowers.filter(vFollower => !vFollower.inCombat);
				}

				let vPeerOffsets = FollowingManager.computePeerOffsets(vFollowers, pToken.parent.grid, vTravelDirection, pToken, vOldCenter);

				for (let vFollower of vFollowers) {
					let vPeerOffset = vPeerOffsets.get(vFollower.id);

					if (vPeerOffset === null) continue; // no reachable spot this step - hold and retry on the next leader move

					FollowingManager.requestAdvance(vFollower, pToken, {OldCenter: vOldCenter, NewCenter: vNewCenter, PeerOffset: vPeerOffset, Teleport: vTeleport, Depth: vDepth, RidingMovement: false});
				}
			}
		}

		// 2) Grapple-following riders (GM-driven, mirrors the Riding update flow's GM gating)
		if (game.settings.get(cModuleName, "Grappling") && RideableFlags.isRidden(pToken) && game.user.isGM) {
			let vGrappledList = RideableFlags.RiderTokens(pToken).filter(vRider => RideableFlags.isGrappled(vRider));

			if (vGrappledList.length) {
				let vPeerOffsets = FollowingManager.computePeerOffsets(vGrappledList, pToken.parent.grid, vTravelDirection, pToken, vOldCenter);

				for (let vGrappled of vGrappledList) {
					let vPeerOffset = vPeerOffsets.get(vGrappled.id);

					if (vPeerOffset === null) continue; // no reachable spot this step - hold and retry on the next leader move

					FollowingManager.requestAdvance(vGrappled, pToken, {OldCenter: vOldCenter, NewCenter: vNewCenter, PeerOffset: vPeerOffset, Teleport: vTeleport, Depth: vDepth, RidingMovement: true});
				}
			}
		}

		// 3) Independent follower movement: this token moved on its own while following something
		if (!pOperation.RideableFollowingMovement && pToken.isOwner
			&& RideableFlags.isFollowing(pToken) && RideableFlags.isFollowOrderSource(pToken)) {
			switch (game.settings.get(cModuleName, "OnFollowerMovement")) {
				case "continuefollowing":
					// Do nothing: the follow relationship stays intact and the follower will
					// resync to the leader (from wherever it now is) on the leader's next move.
					break;
				case "stopfollowing":
				default:
					await FollowingManager.StopFollowing([pToken]);
					break;
			}
		}
	}

	static OnCombatantUpdate(pCombatant) {
		let vToken = pCombatant?.token;

		if (["stop", "stop-includefollowed"].includes(game.settings.get(cModuleName, "FollowingCombatBehaviour"))) {
			if (vToken?.inCombat) {
				if (vToken.isOwner && RideableFlags.isFollowing(vToken) && RideableFlags.isFollowOrderSource(vToken)) {
					FollowingManager.StopFollowing([vToken]);
				}

				if (game.settings.get(cModuleName, "FollowingCombatBehaviour") == "stop-includefollowed") {
					let vFollowers = RideableFlags.followingTokens(vToken).filter(vToken => vToken.isOwner && RideableFlags.isFollowOrderSource(vToken));

					FollowingManager.StopFollowing(vFollowers);
				}
			}
		}
	}

	static async OnCanvasReady(pCanvas) {
		// One-time migration: strip legacy path-history/index/planned-route flags left over from
		// earlier iterations of the following system. Nothing in the module writes or reads these
		// anymore - each moveToken event's own before/after positions are used directly instead.
		// Raw flag keys are used here deliberately since the RideableFlags API for them is gone.
		if (game.user.isGM) {
			let vUpdates = [];

			for (let vToken of canvas.tokens.placeables.map(vToken => vToken.document)) {
				let vFlags = vToken.flags?.[cModuleName];
				let vUpdate = {};

				if (vFlags?.PathHistoryFlag !== undefined) {
					vUpdate[`flags.${cModuleName}.-=PathHistoryFlag`] = null;
				}

				if (vFlags?.PathIndexFlag !== undefined) {
					vUpdate[`flags.${cModuleName}.-=PathIndexFlag`] = null;
				}

				if (vFlags?.plannedRouteFlag !== undefined) {
					vUpdate[`flags.${cModuleName}.-=plannedRouteFlag`] = null;
				}

				if (Object.keys(vUpdate).length) {
					vUpdate._id = vToken.id;
					vUpdates.push(vUpdate);
				}
			}

			if (vUpdates.length) {
				await canvas.scene.updateEmbeddedDocuments("Token", vUpdates);
			}
		}
	}

	static OnStartFollowing(pToken, pFollowed, pPopup = true) {
		if (pPopup) {
			RideablePopups.TextPopUpID(pToken ,"StartFollowing", {pFollowedName : RideableFlags.RideableName(pFollowed)}, {type : "success"}); //MESSAGE POPUP
		}

		Hooks.call(cModuleName + ".StartFollowing", pToken, pFollowed);
	}

	static OnStopFollowing(pToken, pPopup = true) {
		if (pPopup) {
			RideablePopups.TextPopUpID(pToken ,"StopFollowing", {}, {type : "success"}); //MESSAGE POPUP
		}

		Hooks.call(cModuleName + ".StopFollowing", pToken);
	}
}

Hooks.once("ready", function () {
	if (FollowingManager.FollowingActive()) {
		Hooks.on("moveToken", (...args) => FollowingManager.OnTokenmove(...args));

		Hooks.on("canvasReady", (...args) => FollowingManager.OnCanvasReady(...args));

		Hooks.on("createCombatant", (pCombatant) => {FollowingManager.OnCombatantUpdate(pCombatant)});

		Hooks.on("deleteCombatant", (pCombatant) => {FollowingManager.OnCombatantUpdate(pCombatant)});
	}
});

//exports
export function SelectedFollowHovered(pConsiderTargeted = true) {return FollowingManager.SelectedFollowHovered(pConsiderTargeted)};

export function SelectedFollowHoveredatDistance(pDistance) {return FollowingManager.SelectedFollowHovered(true, pDistance)}

export function SelectedStopFollowing() {return FollowingManager.SelectedStopFollowing()};

export function SelectedToggleFollwing() {return FollowingManager.SelectedToggleFollwing(true)};

export function SelectedToggleFollwingatDistance(pDistance) {return FollowingManager.SelectedToggleFollwing(true, pDistance)};

export function FollowbyID(pFollowerIDs, pTargetID, pSceneID = null, pDistance = -1) {FollowingManager.FollowToken(RideableUtils.TokensfromIDs(pFollowerIDs, game.scenes.get(pSceneID)), RideableUtils.TokenfromID(pTargetID, game.scenes.get(pSceneID)), pDistance)};

export function StopFollowbyID(pFollowerIDs, pSceneID = null) {FollowingManager.StopFollowing(RideableUtils.TokensfromIDs(pFollowerIDs, game.scenes.get(pSceneID)))};

export function FollowTokenRequest(pData) {FollowingManager.FollowTokenRequest(pData)}

export function StopFollowingRequest(pData) {FollowingManager.StopFollowingRequest(pData)}
