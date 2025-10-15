import mongoose, { Schema } from "mongoose";

const studentSchema = new Schema({
    surname: {
        type: String,
        required: [true, "Surname is required"],
        trim: true,
    },
    firstname: {
        type: String,
        required: [true, "First name is required"],
        trim: true,
    },
    middlename: {
        type: String,
        trim: true,
    },
    regNo: {
        type: String,
        required: [true, "Registration number is required"],
        unique: true,
        trim: true,
        uppercase: true,
        index: true,
        validate: {
            validator: function(v) {
                // Validate format: XX/XXXXX/UE or XX/XXXXX/DE
                return /^\d{2}\/\d{5}\/(UE|DE)$/.test(v);
            },
            message: props => `${props.value} is not a valid registration number format (should be XX/XXXXX/UE or XX/XXXXX/DE)`
        }
    },
    regNoNumeric: {
        type: Number,
        index: true
    },
    regNoSuffix: {
        type: String,
        enum: ['UE', 'DE'],
        index: true
    },
    college: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'College',
        required: true,
        index: true,
    },
    department: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Department',
        required: true,
        index: true,
    },
    programme: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Programme',
        required: true,
        index: true,
    },
    level: {
        type: String,
        required: [true, "Level is required"],
        trim: true,
    },
    status: {
        type: String,
        enum: ['undergraduate', 'graduated', 'extraYear'],
        default: 'undergraduate',
    },
    standing: {
        type: String,
        enum: ['goodstanding', 'deferred', 'withdrawn', 'readmitted'],
        default: 'goodstanding',
        lowercase: true,
        trim: true,
    },
    standingEvidence: {
        documentPath: { type: String },
        documentName: { type: String },
        documentNumber: { type: String },
        updatedAt: { type: Date }
    },
    passport: {
        data: {
            type: Buffer,
            select: false
        },
        contentType: { type: String },
        updatedAt: { type: Date }
    }
}, { timestamps: true });

// Auto-extract numeric part and suffix before saving
studentSchema.pre("save", function(next) {
    if (this.isModified('regNo')) {
        const parts = this.regNo.split("/");
        this.regNoNumeric = parseInt(parts[1], 10);
        this.regNoSuffix = parts[2];
        
        if (isNaN(this.regNoNumeric)) {
            throw new Error('Invalid numeric part in registration number');
        }
        if (!['UE', 'DE'].includes(this.regNoSuffix)) {
            throw new Error('Invalid suffix in registration number');
        }
    }
    next();
});

// Default sorting by numeric part then suffix for all queries
studentSchema.pre(/^find/, function(next) {
    if (!this.options.sort) {
        this.sort({ regNoNumeric: 1, regNoSuffix: 1 }); // Sort by numeric value then suffix
    }
    next();
});

// Compound index for efficient queries
studentSchema.index({ regNoNumeric: 1, regNoSuffix: 1 });

export default mongoose.model("Student", studentSchema);
