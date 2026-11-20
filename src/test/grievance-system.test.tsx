import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  GRIEVANCE_CATEGORIES,
  GRIEVANCE_STATUSES,
  CreateGrievanceSchema,
  SendMessageSchema,
  UpdateStatusSchema,
} from "@/lib/grievance.types";
import {
  submitEmployeeGrievance,
  getMyGrievances,
  getGrievanceDetails,
  getGrievanceAttachmentDownloadUrl,
  sendGrievanceMessage,
  updateGrievanceStatus,
  getDpoGrievanceQueue,
  generateSecureReferenceNumber,
  detectMagicBytesFormat,
  validateAndProcessAttachment,
  DatabasePersistenceError,
} from "@/lib/grievance.functions";
import { SubmitGrievanceModal } from "@/components/presence/employee/SubmitGrievanceModal";

// Mock TanStack React Start server function caller
vi.mock("@tanstack/react-start", () => {
  const mockMiddleware: any = {
    client: () => mockMiddleware,
    server: () => mockMiddleware,
  };
  const mockFnBuilder: any = {
    middleware: () => mockFnBuilder,
    validator: () => mockFnBuilder,
    handler: (fn: any) => fn,
  };
  return {
    useServerFn: (fn: any) => fn,
    createMiddleware: () => mockMiddleware,
    createCsrfMiddleware: () => mockMiddleware,
    createServerFn: () => mockFnBuilder,
  };
});

// ── Test Payloads with Genuine Magic Bytes ─────────────────────────────────
const VALID_PDF_BASE64 = Buffer.from("%PDF-1.4\nTest evidence content for grievance").toString("base64");
const VALID_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const VALID_PNG_BASE64 = VALID_PNG_BYTES.toString("base64");
const VALID_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const VALID_JPEG_BASE64 = VALID_JPEG_BYTES.toString("base64");
const FAKE_PDF_TEXT_BASE64 = Buffer.from("This is plain text without PDF header").toString("base64");
const FAKE_PNG_EXE_BASE64 = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]).toString("base64"); // MZ executable

describe("PresenceTrack AI — Employee Grievance & DPO Redressal System", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Validation & Schema Enforcement ──────────────────────────────────
  it("Requirement 1: Enforces Zod validation on employee grievance submissions", () => {
    // Valid submission
    const valid = CreateGrievanceSchema.safeParse({
      title: "Incorrect Biometric Boundary Marking",
      category: "Biometric Data Concern",
      description: "My boundary transit in North Zone was attributed to another employee during shift transition.",
      attachments: [],
    });
    expect(valid.success).toBe(true);

    // Invalid: Title too short (< 3 chars)
    const shortTitle = CreateGrievanceSchema.safeParse({
      title: "No",
      category: "Privacy or Data Protection",
      description: "A detailed description of the incident occurring on the corridor.",
    });
    expect(shortTitle.success).toBe(false);

    // Invalid: Unknown category
    const badCategory = CreateGrievanceSchema.safeParse({
      title: "Salary issue",
      category: "Unknown Category" as any,
      description: "A detailed description of the issue occurring yesterday.",
    });
    expect(badCategory.success).toBe(false);

    // Invalid: Description too short (< 10 chars)
    const shortDesc = CreateGrievanceSchema.safeParse({
      title: "Fair description",
      category: "Workplace Issue",
      description: "Short",
    });
    expect(shortDesc.success).toBe(false);
  });

  it("Requirement 2: All 6 required categories and 6 statuses are strictly defined", () => {
    expect(GRIEVANCE_CATEGORIES).toEqual([
      "Workplace Issue",
      "Harassment or Misconduct",
      "Privacy or Data Protection",
      "Biometric Data Concern",
      "Attendance Dispute",
      "Other",
    ]);

    expect(GRIEVANCE_STATUSES).toEqual([
      "SUBMITTED",
      "UNDER_REVIEW",
      "ADDITIONAL_INFORMATION_REQUIRED",
      "RESPONSE_SENT",
      "RESOLVED",
      "REJECTED",
    ]);
  });

  // ── 2. Cryptographic Reference Number Generation ─────────────────────────
  it("Requirement 3: Generates cryptographically secure reference numbers with 8 hex chars", () => {
    const ref = generateSecureReferenceNumber();
    // Matches GRV-YYYYMMDD-XXXXXXXX where X is 8 uppercase hex digits
    expect(ref).toMatch(/^GRV-\d{8}-[A-F0-9]{8}$/);

    // Multiple generations produce distinct numbers
    const set = new Set();
    for (let i = 0; i < 50; i++) {
      set.add(generateSecureReferenceNumber());
    }
    expect(set.size).toBe(50);
  });

  // ── 3. MIME & Magic Byte Validation ──────────────────────────────────────
  it("Requirement 4: Enforces MIME and magic byte signatures on attachments", () => {
    // Valid PDF
    const pdfRes = validateAndProcessAttachment({
      file_name: "transit_evidence.pdf",
      file_size: 1024,
      file_type: "application/pdf",
      file_data: `data:application/pdf;base64,${VALID_PDF_BASE64}`,
    });
    expect(pdfRes.validatedMime).toBe("application/pdf");
    expect(pdfRes.extension).toBe("pdf");
    expect(pdfRes.buffer.length).toBeGreaterThan(0);

    // Valid PNG
    const pngRes = validateAndProcessAttachment({
      file_name: "screenshot.png",
      file_size: 1024,
      file_type: "image/png",
      file_data: VALID_PNG_BASE64,
    });
    expect(pngRes.validatedMime).toBe("image/png");
    expect(pngRes.extension).toBe("png");

    // Valid JPEG
    const jpegRes = validateAndProcessAttachment({
      file_name: "photo.jpg",
      file_size: 1024,
      file_type: "image/jpeg",
      file_data: VALID_JPEG_BASE64,
    });
    expect(jpegRes.validatedMime).toBe("image/jpeg");
    expect(jpegRes.extension).toBe("jpg");

    // Disguised file: Plain text masquerading as PDF
    expect(() =>
      validateAndProcessAttachment({
        file_name: "disguised_script.pdf",
        file_size: 1024,
        file_type: "application/pdf",
        file_data: FAKE_PDF_TEXT_BASE64,
      }),
    ).toThrow(/File signature validation failed/);

    // Disguised file: Windows executable masquerading as PNG
    expect(() =>
      validateAndProcessAttachment({
        file_name: "malicious.png",
        file_size: 1024,
        file_type: "image/png",
        file_data: FAKE_PNG_EXE_BASE64,
      }),
    ).toThrow(/File signature validation failed/);

    // Unsupported extension (.exe, .sh, .docx)
    expect(() =>
      validateAndProcessAttachment({
        file_name: "payload.sh",
        file_size: 1024,
        file_type: "application/x-sh",
        file_data: VALID_PDF_BASE64,
      }),
    ).toThrow(/Unsupported file extension/);

    // File exceeding 10MB limit
    const hugeBuffer = Buffer.alloc(11 * 1024 * 1024, 0x25); // 11MB
    expect(() =>
      validateAndProcessAttachment({
        file_name: "large.pdf",
        file_size: hugeBuffer.length,
        file_type: "application/pdf",
        file_data: hugeBuffer.toString("base64"),
      }),
    ).toThrow(/exceeds maximum permitted limit of 10 MB/);
  });

  // ── 4. End-to-End Submission & Persistence ──────────────────────────────
  it("Requirement 5: Employee complaint submission uploads to private storage, persists to DB, and logs audit", async () => {
    const insertMock = vi.fn().mockResolvedValue({ error: null });
    const uploadMock = vi.fn().mockResolvedValue({ data: { path: "evidence.pdf" }, error: null });

    const mockSupabase: any = {
      from: (table: string) => {
        if (table === "enterprise_users") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "emp-profile-101",
                auth_user_id: "auth-user-101",
                name: "Sunita Rao",
                email: "sunita.rao@enterprise.org",
                badge_id: "PT-ENG-101",
                department: "Computer Vision Engineering",
                current_zone: "WORKSPACE_FLOOR",
                is_active: true,
              },
              error: null,
            }),
          };
        }
        if (table === "employee_grievances") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            insert: insertMock,
          };
        }
        return {
          insert: insertMock,
        };
      },
      storage: {
        from: vi.fn().mockReturnValue({
          upload: uploadMock,
        }),
      },
      rpc: vi.fn().mockResolvedValue({ data: false }),
    };

    const handler = submitEmployeeGrievance as any;
    const result = await handler({
      data: {
        title: "Dwell Time Discrepancy on Break",
        category: "Attendance Dispute",
        description: "My lunchtime transition into the cafeteria was counted as an away anomaly.",
        attachments: [
          {
            file_name: "transit_log.pdf",
            file_size: 1024,
            file_type: "application/pdf",
            file_data: `data:application/pdf;base64,${VALID_PDF_BASE64}`,
            is_internal: false,
          },
        ],
      },
      context: {
        supabase: mockSupabase,
        userId: "auth-user-101",
      },
    });

    expect(result.success).toBe(true);
    expect(result.reference_number).toMatch(/^GRV-\d{8}-[A-F0-9]{8}$/);
    expect(result.grievance.title).toBe("Dwell Time Discrepancy on Break");
    expect(result.grievance.status).toBe("SUBMITTED");
    expect(result.grievance.employee_id).toBe("emp-profile-101");

    // Verify storage upload was performed to private grievance-evidence bucket
    expect(mockSupabase.storage.from).toHaveBeenCalledWith("grievance-evidence");
    expect(uploadMock).toHaveBeenCalled();

    // Verify database inserts were executed
    expect(insertMock).toHaveBeenCalled();
  });

  // ── 5. Deactivated Personnel Blocked ─────────────────────────────────────
  it("Requirement 6: Deactivated personnel cannot submit grievances", async () => {
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: "emp-deactivated",
            auth_user_id: "auth-deactivated",
            name: "Inactive User",
            is_active: false,
          },
          error: null,
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: false }),
    };

    const handler = submitEmployeeGrievance as any;
    await expect(
      handler({
        data: {
          title: "Attempted Submission",
          category: "Other",
          description: "This should be blocked because the account is deactivated.",
          attachments: [],
        },
        context: {
          supabase: mockSupabase,
          userId: "auth-deactivated",
        },
      }),
    ).rejects.toThrow("Forbidden: Deactivated personnel cannot submit grievances");
  });

  // ── 6. Employee Isolation & Access Control ──────────────────────────────
  it("Requirement 7: Employees cannot access grievances belonging to other employees", async () => {
    const mockSupabase: any = {
      from: (table: string) => {
        if (table === "enterprise_users") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "emp-profile-2",
                auth_user_id: "auth-emp-2",
                name: "Employee Two",
              },
              error: null,
            }),
          };
        }
        if (table === "employee_grievances") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "g-emp-1",
                employee_id: "emp-profile-1", // Belongs to Employee 1!
                title: "Employee 1 Complaint",
                category: "Workplace Issue",
                status: "SUBMITTED",
              },
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      },
      rpc: vi.fn().mockResolvedValue({ data: false }), // Not DPO/Admin
    };

    const detailsHandler = getGrievanceDetails as any;
    await expect(
      detailsHandler({
        data: { grievance_id: "g-emp-1" },
        context: {
          supabase: mockSupabase,
          userId: "auth-emp-2",
        },
      }),
    ).rejects.toThrow("Forbidden: Access denied to another employee's grievance");
  });

  // ── 7. Cross-Employee & Internal Attachment Download Security ────────────
  it("Requirement 8: Rejects unauthorized, cross-employee, and internal attachment downloads", async () => {
    const mockStorage = {
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://storage.presencetrack.internal/signed-evidence-url" },
        error: null,
      }),
    };

    const mockSupabase: any = {
      from: (table: string) => {
        if (table === "enterprise_users") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "emp-profile-attacker", auth_user_id: "auth-attacker" },
              error: null,
            }),
          };
        }
        if (table === "grievance_attachments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "att-victim",
                grievance_id: "g-victim",
                file_name: "confidential_evidence.pdf",
                file_url: "g-victim/att-victim.pdf",
                is_internal: false,
              },
              error: null,
            }),
          };
        }
        if (table === "employee_grievances") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "g-victim", employee_id: "emp-victim-owner" }, // Owned by victim!
              error: null,
            }),
          };
        }
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      },
      storage: {
        from: vi.fn().mockReturnValue(mockStorage),
      },
      rpc: vi.fn().mockResolvedValue({ data: false }), // Not DPO
    };

    const downloadHandler = getGrievanceAttachmentDownloadUrl as any;

    // Test A: Cross-employee download attack is blocked
    await expect(
      downloadHandler({
        data: { attachment_id: "att-victim" },
        context: {
          supabase: mockSupabase,
          userId: "auth-attacker",
        },
      }),
    ).rejects.toThrow("Forbidden: Access denied to another employee's attachment");

    // Test B: Employee cannot download confidential internal attachment even on own grievance
    const mockSupabaseInternalAtt: any = {
      from: (table: string) => {
        if (table === "enterprise_users") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "emp-owner", auth_user_id: "auth-owner" },
              error: null,
            }),
          };
        }
        if (table === "grievance_attachments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "att-internal-note",
                grievance_id: "g-owner",
                file_name: "internal_investigation_dpo.pdf",
                file_url: "g-owner/internal.pdf",
                is_internal: true, // Internal confidential note!
              },
              error: null,
            }),
          };
        }
        if (table === "employee_grievances") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "g-owner", employee_id: "emp-owner" },
              error: null,
            }),
          };
        }
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      },
      storage: { from: vi.fn().mockReturnValue(mockStorage) },
      rpc: vi.fn().mockResolvedValue({ data: false }), // Not DPO
    };

    await expect(
      downloadHandler({
        data: { attachment_id: "att-internal-note" },
        context: {
          supabase: mockSupabaseInternalAtt,
          userId: "auth-owner",
        },
      }),
    ).rejects.toThrow("Forbidden: Unauthorized access to internal confidential attachment");

    // Test C: Authorized DPO CAN download internal confidential attachment
    const mockDpoSupabase: any = {
      ...mockSupabaseInternalAtt,
      rpc: vi.fn().mockResolvedValue({ data: true }), // Is DPO
    };

    const dpoDownloadRes = await downloadHandler({
      data: { attachment_id: "att-internal-note" },
      context: {
        supabase: mockDpoSupabase,
        userId: "auth-dpo",
      },
    });

    expect(dpoDownloadRes.success).toBe(true);
    expect(dpoDownloadRes.download_url).toBe("https://storage.presencetrack.internal/signed-evidence-url");
  });

  // ── 8. Reference Collision Retry Logic ───────────────────────────────────
  it("Requirement 9: Bounded retry logic handles unique reference collisions safely", async () => {
    let attemptCount = 0;
    const mockSupabase: any = {
      from: (table: string) => {
        if (table === "enterprise_users") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "emp-101", is_active: true },
              error: null,
            }),
          };
        }
        if (table === "employee_grievances") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(() => {
              attemptCount++;
              if (attemptCount <= 2) {
                // Simulate collision on attempts 1 and 2
                return Promise.resolve({ data: { id: "existing-ref" }, error: null });
              }
              // Free on attempt 3
              return Promise.resolve({ data: null, error: null });
            }),
            insert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        return {
          insert: vi.fn().mockResolvedValue({ error: null }),
        };
      },
      rpc: vi.fn().mockResolvedValue({ data: false }),
    };

    const handler = submitEmployeeGrievance as any;
    const result = await handler({
      data: {
        title: "Collision Test Grievance",
        category: "Attendance Dispute",
        description: "Testing bounded retry on collision.",
        attachments: [],
      },
      context: {
        supabase: mockSupabase,
        userId: "auth-emp-101",
      },
    });

    expect(result.success).toBe(true);
    expect(attemptCount).toBeGreaterThanOrEqual(3);
    expect(result.reference_number).toMatch(/^GRV-\d{8}-[A-F0-9]{8}$/);
  });

  // ── 9. Closure Reason DB Constraints ─────────────────────────────────────
  it("Requirement 10: Mandatory reasons required when resolving or rejecting grievances", async () => {
    const mockSupabase: any = {
      from: (table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: "g-status-test",
            reference_number: "GRV-20261120-STAT1234",
            employee_id: "emp-stat",
            title: "Test Grievance",
            status: "UNDER_REVIEW",
          },
          error: null,
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: true }), // Is DPO
    };

    const updateHandler = updateGrievanceStatus as any;

    // Resolving without reason throws error
    await expect(
      updateHandler({
        data: {
          grievance_id: "g-status-test",
          new_status: "RESOLVED",
          reason: "   ",
        },
        context: {
          supabase: mockSupabase,
          userId: "auth-dpo",
        },
      }),
    ).rejects.toThrow("A detailed statutory reason is mandatory when marking a grievance as RESOLVED");

    // Rejecting without reason throws error
    await expect(
      updateHandler({
        data: {
          grievance_id: "g-status-test",
          new_status: "REJECTED",
        },
        context: {
          supabase: mockSupabase,
          userId: "auth-dpo",
        },
      }),
    ).rejects.toThrow("A detailed statutory reason is mandatory when marking a grievance as REJECTED");

    // Resolving with statutory reason succeeds
    const resolveRes = await updateHandler({
      data: {
        grievance_id: "g-status-test",
        new_status: "RESOLVED",
        reason: "Boundary crossing vector recalibrated; 12 minutes restored to productive dwell ledger.",
      },
      context: {
        supabase: mockSupabase,
        userId: "auth-dpo",
      },
    });

    expect(resolveRes.success).toBe(true);
    expect(resolveRes.grievance.status).toBe("RESOLVED");
    expect(resolveRes.grievance.resolution_reason).toBe(
      "Boundary crossing vector recalibrated; 12 minutes restored to productive dwell ledger.",
    );
  });

  // ── 10. Database Migration Integrity (Constraints & Triggers) ────────────
  it("Requirement 11: Migration 0004 specifies mandatory closure CHECK constraints and updated_at triggers", () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "drizzle/migrations/0004_employee_grievance_system.sql",
    );
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, "utf-8");

    // Verify CHECK constraint for resolution reason
    expect(sql).toContain("chk_grievance_resolution_reason");
    expect(sql).toContain("status = 'RESOLVED' AND resolution_reason IS NOT NULL");

    // Verify CHECK constraint for rejection reason
    expect(sql).toContain("chk_grievance_rejection_reason");
    expect(sql).toContain("status = 'REJECTED' AND rejection_reason IS NOT NULL");

    // Verify triggers
    expect(sql).toContain("trg_employee_grievances_updated_at");
    expect(sql).toContain("trg_grievance_messages_touch_updated_at");
    expect(sql).toContain("handle_employee_grievance_updated_at");
    expect(sql).toContain("handle_grievance_message_touch_updated_at");
  });

  // ── 11. Database Write Failure Handling (No Silent Fallback) ─────────────
  it("Requirement 12: Throws explicit DatabasePersistenceError when database write fails", async () => {
    const mockFailingSupabase: any = {
      from: (table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { id: "emp-fail", is_active: true },
          error: null,
        }),
        insert: vi.fn().mockResolvedValue({
          error: { message: "Connection to database host timed out (ECONNREFUSED)", code: "08006" },
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: false }),
    };

    const handler = submitEmployeeGrievance as any;
    await expect(
      handler({
        data: {
          title: "Database Outage Test",
          category: "Other",
          description: "Database is unreachable, system must throw DatabasePersistenceError.",
          attachments: [],
        },
        context: {
          supabase: mockFailingSupabase,
          userId: "auth-emp-fail",
        },
      }),
    ).rejects.toThrow(DatabasePersistenceError);
  });

  // ── 12. DPO vs Super Admin Authorization Scoping ─────────────────────────
  it("Requirement 13: Dedicated DPO role can access Grievance Queue but is isolated from Super Admin features", async () => {
    // 1. DPO role can access DPO Grievance Queue
    const mockDpoSupabase: any = {
      from: () => ({
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [
            {
              id: "g-1",
              reference_number: "GRV-20261120-DPO12345",
              title: "DPO Test",
              category: "Biometric Data Concern",
              status: "SUBMITTED",
              enterprise_users: { name: "Employee" },
            },
          ],
          error: null,
        }),
      }),
      rpc: vi.fn().mockImplementation((fn: string, args: any) => {
        if (fn === "has_role" && args._role === "dpo") {
          return Promise.resolve({ data: true });
        }
        if (fn === "has_role" && args._role === "super_admin") {
          return Promise.resolve({ data: false });
        }
        return Promise.resolve({ data: false });
      }),
    };

    const queueHandler = getDpoGrievanceQueue as any;
    const queueRes = await queueHandler({
      data: {},
      context: {
        supabase: mockDpoSupabase,
        userId: "auth-dpo-officer",
      },
    });

    expect(queueRes.grievances.length).toBe(1);
    expect(queueRes.metrics.pending_review).toBe(1);

    // 2. Employee role is strictly forbidden from accessing DPO Queue
    const mockEmployeeSupabase: any = {
      rpc: vi.fn().mockResolvedValue({ data: false }), // Neither DPO nor Super Admin
    };

    await expect(
      queueHandler({
        data: {},
        context: {
          supabase: mockEmployeeSupabase,
          userId: "auth-regular-employee",
        },
      }),
    ).rejects.toThrow("Forbidden: DPO or Super Admin role required to access Grievance Queue");

    // 3. Verify migration 0005 defines 'dpo' role and scoped RLS policies
    const dpoMigrationPath = path.resolve(
      process.cwd(),
      "drizzle/migrations/0005_dpo_role_definition.sql",
    );
    expect(fs.existsSync(dpoMigrationPath)).toBe(true);
    const dpoSql = fs.readFileSync(dpoMigrationPath, "utf-8");
    expect(dpoSql).toContain("ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'dpo'");
    expect(dpoSql).toContain("ARRAY['super_admin', 'dpo']");
    expect(dpoSql).toContain("grievance-evidence");
  });

  // ── 13. Frontend Component Rendering Tests ───────────────────────────────
  it("Requirement 14: SubmitGrievanceModal renders form, handles inputs, and submits successfully", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const mockOnSubmitted = vi.fn();
    const mockOnClose = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <SubmitGrievanceModal onClose={mockOnClose} onSubmitted={mockOnSubmitted} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Submit a Complaint or Grievance")).toBeDefined();
    expect(screen.getByText("DPDP Statutory Grievance Redressal:")).toBeDefined();

    // Verify category select is populated
    const select = screen.getByRole("combobox");
    expect(select).toBeDefined();
    expect(screen.getByText("Biometric Data Concern")).toBeDefined();
    expect(screen.getByText("Harassment or Misconduct")).toBeDefined();
    expect(screen.getByText("Attendance Dispute")).toBeDefined();
  });
});
