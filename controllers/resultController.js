import Result from "../models/result.js";

// Create (C)
export const createResult = async (req, res) => {
  try {
    const newResult = await Result.create(req.body);
    res.status(201).json(newResult);
  } catch (error) {
    console.error("Error creating result:", error);
    if (error.name === "ValidationError") {
      return res
        .status(400)
        .json({ message: "Validation Error", errors: error.errors });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Read (R) - Fetch All
export const getAllResults = async (req, res) => {
  try {
    const results = await Result.find()
      .populate("student", "surname firstname regNo")
      .populate("course", "title code")
      .populate("lecturer", "title surname firstname");
    res.status(200).json(results);
  } catch (error) {
    console.error("Error fetching results:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Read (R) - Fetch One by ID
export const getResultById = async (req, res) => {
  try {
    const result = await Result.findById(req.params.id)
      .populate("student", "surname firstname regNo")
      .populate("course", "title code")
      .populate("lecturer", "title surname firstname");

    if (!result) {
      return res.status(404).json({ message: "Result not found" });
    }
    res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching result:", error);
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Update (U)
export const updateResult = async (req, res) => {
  try {
    const updatedResult = await Result.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!updatedResult) {
      return res.status(404).json({ message: "Result not found" });
    }
    res.status(200).json(updatedResult);
  } catch (error) {
    console.error("Error updating result:", error);
    if (error.name === "ValidationError") {
      return res
        .status(400)
        .json({ message: "Validation Error", errors: error.errors });
    }
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Delete (D)
export const deleteResult = async (req, res) => {
  try {
    const deletedResult = await Result.findByIdAndDelete(req.params.id);
    if (!deletedResult) {
      return res.status(404).json({ message: "Result not found" });
    }
    res.status(200).json({ message: "Result deleted successfully" });
  } catch (error) {
    console.error("Error deleting result:", error);
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};
